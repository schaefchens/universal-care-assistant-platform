/**
 * What the connectors process reports, stored (docs/plan.md, Appendix F "Mapping"): conversations, the people in them,
 * messages with their edits and attachments, deletions and read states. Every write is idempotent: the same report
 * twice (a replay after a restart, the history fetched again) changes nothing.
 */
import type { WireChat, WireMessage, WireUser } from '@ucap/shared';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { Db, Exec } from '../lib/db.ts';

const at = (seconds: number) => new Date(seconds * 1000);
/** Telegram's message ids are integers in order; another service's are not, and then sort by time. */
const sortKey = (m: WireMessage) => (/^-?\d{1,18}$/.test(m.externalId) ? m.externalId : String(m.date));

export interface Upserted {
  id: string;
  conversationId: string;
  inserted: boolean;
  /** Its text changed (an edit). */
  changed: boolean;
}

export function createMessageStore(d: { db: Db; clock: Clock }) {
  const now = () => new Date(d.clock());

  async function conversationOf(exec: Exec, connectionId: string, chatId: string): Promise<{ id: string; readInboxMax: string | null; readOutboxMax: string | null }> {
    const r = await sql<{ id: string; read_inbox_max: string | null; read_outbox_max: string | null }>`
      select id, read_inbox_max, read_outbox_max from messaging_conversations where connection_id = ${connectionId} and external_id = ${chatId}`.execute(exec);
    if (r.rows[0]) return { id: r.rows[0].id, readInboxMax: r.rows[0].read_inbox_max, readOutboxMax: r.rows[0].read_outbox_max };
    // A message before its chat (TDLib sends the chat first; a gap after a restart could reverse it): a placeholder
    // the chat's own report fills in.
    const id = uuidv7(d.clock());
    await sql`
      insert into messaging_conversations (id, connection_id, external_id, kind, title, updated_at)
      values (${id}, ${connectionId}, ${chatId}, 'private', '', ${now()}) on conflict (connection_id, external_id) do nothing`.execute(exec);
    return conversationOf(exec, connectionId, chatId);
  }

  return {
    async upsertChat(connectionId: string, c: WireChat): Promise<string> {
      return d.db.transaction().execute(async (trx) => {
        const r = await sql<{ id: string }>`
          insert into messaging_conversations (id, connection_id, external_id, kind, title, subject, peer_external_id, muted, unread, read_inbox_max, read_outbox_max, updated_at)
          values (${uuidv7(d.clock())}, ${connectionId}, ${c.externalId}, ${c.kind}, ${c.title}, ${c.subject ?? null}, ${c.userId}, ${c.muted}, ${c.unread}, ${c.readInboxMaxId}, ${c.readOutboxMaxId}, ${now()})
          on conflict (connection_id, external_id) do update set kind = excluded.kind, title = excluded.title, subject = coalesce(excluded.subject, messaging_conversations.subject), peer_external_id = excluded.peer_external_id,
            muted = excluded.muted, unread = excluded.unread,
            read_inbox_max = greatest(messaging_conversations.read_inbox_max, excluded.read_inbox_max),
            read_outbox_max = greatest(messaging_conversations.read_outbox_max, excluded.read_outbox_max), updated_at = excluded.updated_at
          returning id`.execute(trx);
        const id = r.rows[0]!.id;
        await applyRead(trx, id, c.readInboxMaxId, c.readOutboxMaxId);
        return id;
      });
    },

    async upsertUser(connectionId: string, u: WireUser): Promise<void> {
      await sql`
        insert into messaging_participants (connection_id, external_id, name, is_contact, is_bot, updated_at)
        values (${connectionId}, ${u.externalId}, ${u.name}, ${u.isContact}, ${u.isBot}, ${now()})
        on conflict (connection_id, external_id) do update set name = excluded.name, is_contact = excluded.is_contact, is_bot = excluded.is_bot, updated_at = excluded.updated_at`.execute(d.db);
    },

    /**
     * `history`: the time the person connected the service, for a message that did not just arrive. What the service
     * sends from before it is no news: read here, whatever the service says, and never marked read there (the owner,
     * 2026-10-22: "only show new messages from that time onwards").
     */
    async upsertMessage(connectionId: string, m: WireMessage, o: { history?: Date } = {}): Promise<Upserted> {
      return d.db.transaction().execute(async (trx) => {
        const conv = await conversationOf(trx, connectionId, m.chatId);
        const key = sortKey(m);
        // Read already, as far as the service says, or from before the person connected it.
        const readMax = m.outgoing ? conv.readOutboxMax : conv.readInboxMax;
        const fromHistory = !m.outgoing && o.history !== undefined && m.date * 1000 < o.history.getTime();
        const read = fromHistory || (readMax !== null && BigInt(key) <= BigInt(readMax)) ? now() : null;
        const before = await sql<{ text: string }>`select text from messaging_messages where conversation_id = ${conv.id} and external_id = ${m.externalId}`.execute(trx);
        const r = await sql<{ id: string; inserted: boolean }>`
          insert into messaging_messages (id, conversation_id, external_id, sort_key, sender_external_id, direction, kind, text, file_name, subject, sent_at, edited_at, read_at, created_at, updated_at)
          values (${uuidv7(d.clock())}, ${conv.id}, ${m.externalId}, ${key}, ${m.fromId}, ${m.outgoing ? 'out' : 'in'}, ${m.kind}, ${m.text}, ${m.fileName}, ${m.subject ?? null},
                  ${at(m.date)}, ${m.editDate ? at(m.editDate) : null}, ${read}, ${now()}, ${now()})
          on conflict (conversation_id, external_id) do update set kind = excluded.kind, text = excluded.text, file_name = excluded.file_name, subject = excluded.subject,
            edited_at = excluded.edited_at, updated_at = excluded.updated_at
          returning id, (xmax = 0) as inserted`.execute(trx);
        const { id, inserted } = r.rows[0]!;
        if (m.file) {
          await sql`
            insert into messaging_attachments (message_id, service_file_id, mime, bytes, duration_s, updated_at)
            values (${id}, ${m.file.fileId}, ${m.file.mime}, ${m.file.size}, ${m.file.durationS}, ${now()})
            on conflict (message_id) do update set service_file_id = excluded.service_file_id, mime = excluded.mime, bytes = excluded.bytes, duration_s = excluded.duration_s`.execute(trx);
        }
        await sql`update messaging_conversations set last_message_at = greatest(last_message_at, ${at(m.date)}) where id = ${conv.id}`.execute(trx);
        return { id, conversationId: conv.id, inserted, changed: !inserted && before.rows[0]?.text !== m.text };
      });
    },

    /** Deleted for everyone on the service: UCAP's copy goes too. Returns the stored files to remove. */
    async deleteMessages(connectionId: string, chatId: string, externalIds: string[]): Promise<{ conversationId: string | null; files: string[] }> {
      return d.db.transaction().execute(async (trx) => {
        const c = await sql<{ id: string }>`select id from messaging_conversations where connection_id = ${connectionId} and external_id = ${chatId}`.execute(trx);
        const conv = c.rows[0]?.id;
        if (!conv) return { conversationId: null, files: [] };
        const f = await sql<{ file_id: string }>`
          select a.file_id from messaging_attachments a join messaging_messages m on m.id = a.message_id
          where m.conversation_id = ${conv} and m.external_id = any(${externalIds}::text[]) and a.file_id is not null`.execute(trx);
        await sql`delete from messaging_messages where conversation_id = ${conv} and external_id = any(${externalIds}::text[])`.execute(trx);
        return { conversationId: conv, files: f.rows.map((x) => x.file_id) };
      });
    },

    async read(connectionId: string, chatId: string, inboxMax: string | null, outboxMax: string | null, unread?: number): Promise<void> {
      await d.db.transaction().execute(async (trx) => {
        const c = await sql<{ id: string }>`
          update messaging_conversations set read_inbox_max = greatest(read_inbox_max, ${inboxMax}::bigint), read_outbox_max = greatest(read_outbox_max, ${outboxMax}::bigint),
            unread = coalesce(${unread ?? null}::int, unread), updated_at = ${now()}
          where connection_id = ${connectionId} and external_id = ${chatId} returning id`.execute(trx);
        if (c.rows[0]) await applyRead(trx, c.rows[0].id, inboxMax, outboxMax);
      });
    },
  };

  async function applyRead(exec: Exec, conversationId: string, inboxMax: string | null, outboxMax: string | null) {
    if (inboxMax) await sql`update messaging_messages set read_at = ${now()} where conversation_id = ${conversationId} and direction = 'in' and read_at is null and sort_key <= ${inboxMax}::bigint`.execute(exec);
    if (outboxMax) await sql`update messaging_messages set read_at = ${now()} where conversation_id = ${conversationId} and direction = 'out' and read_at is null and sort_key <= ${outboxMax}::bigint`.execute(exec);
  }
}

export type MessageStore = ReturnType<typeof createMessageStore>;
