# Decisions made during implementation

Where the build departs from the approved plan (`docs/plan.md`), or decides something the plan left open, it is
listed here with what the plan said, what was built and why. Items marked **to confirm** wait for the owner; until
then they stay as built, and nothing here is frozen.

## S2: identity and devices (2026-10-14)

### To confirm

1. **German word list: 4-letter prefixes may repeat English ones.**
   - Plan: “disjoint from BIP39 English, so the language is detected per word”, with unique 4-letter prefixes.
   - Built: German words are unique among themselves (including their 4-letter prefixes) and never equal an English
     word. A German word may, however, start with the same four letters as an English one.
   - Why: with prefix disjointness across both lists, too few curated nouns remained (1693 of 2048). Recovery asks
     for the language first, so typing never mixes the lists.
2. **German word list: two edits apart for every word.**
   - Plan: “Levenshtein distance ≥ 2 between any two words (≥ 3 if both have ≤ 5 letters)”.
   - Built: ≥ 2 for all words.
   - Why: with 3 for short words, too few curated nouns remained. The checksum still catches about 15 of 16 single
     mistakes, and the in-app picker never lets a person type a word that is not on the list.
3. **German word list: the speech check flags, it does not remove.**
   - Plan: “A word that does not come back as itself is removed.”
   - Built: only real confusions are removed (heard as another list word or a command: 4 of 2168 words). Words heard
     as something else (547) go to your listening list, with what was heard.
   - Why: whisper on a single word is noisy (“Apfel” came back as “Atschü”); removing those would drop about a third
     of plain words.
4. **New words when the first were never confirmed (“reissue”).**
   - Plan: rotation needs the old words.
   - Built: as long as an account's words were never confirmed (the ceremony was interrupted: app closed, battery),
     the device that created the account may replace them without the old words. Once confirmed, only a rotation
     with the old words changes them. Audited as `identity.reissued`.
   - Why: otherwise an interrupted ceremony leaves an account whose words nobody holds and that can never get new
     ones. Risk: someone holding that unlocked device in that window could set words of their own; they already
     control the device itself.
5. **The words are only an English rendering on real servers until the German list is frozen.**
   - Plan: “`de-dev` refuses to register against a production server.”
   - Built: on a production server the app gives the words in English instead; English words keep working after the
     German list is frozen. The server says whether it is a development server (`GET /api/v1/server` →
     `development`).
6. **Recovery-word detector: partial phrases are only reported.**
   - Plan: a transcript is dropped “on a match, or a checksum-valid run”.
   - Built as planned (`packages/identity/src/leak.ts`). Nine or more list words without a valid run are reported as
     “suspicious” and not dropped, because shopping lists contain many nouns. But 9 of 12 words leave only about
     2³³ possibilities, which a computer can search. Should a suspicious transcript also be dropped (and the person
     warned), at the cost of some shopping-list notes? This matters from S8 on.
7. **The German list needs a stricter pass before your listening review.** The speech check and the first real
   ceremonies showed words that break the plan's “concrete, familiar nouns”: *jetzt* (not a noun), *Gebote*
   (plural; religion), *Kunz* (a name), *Wesir* (unfamiliar). The next build requires every word to be a singular
   noun from the German noun list and common in the frequency list.

### Decided (within the plan)

- **Successful recovery confirms the words.** Recovering with the words proves the person holds them, so the
  account's recovery state becomes `confirmed`.
- **Word entry is a grid of large areas, not a keyboard.** Only letters that continue a list word are offered, so the
  grid shrinks as the word narrows; with four or fewer words left, they are offered as choices. Twelve German words
  took 48 activations on the emulator (about four per word). A physical keyboard types letters, Backspace deletes,
  Enter takes the word.
- **A new device starts reading events after its enrolment.** Account creation and recovery return the person's
  current event position, so a new device is not told about devices added before it existed.
- **Device names say which device it is**: “Telefon (Pixel 8)”, “Browser (Chrome)”; they can be renamed.
- **The recovery card** has the server's address as text and as a QR code (black on white in every theme, so it
  scans), the server's name and id, the numbered words, and “Diese Wörter stellen deinen Zugang wieder her, nicht
  deine Daten.” It does not claim backups: those are the operator's (S12).
- **AN-13** (voice data removed blocks the ceremony with TalkBack): the check is built and passes on the emulator,
  whose German voices are installed. Removing them needs Google's settings app; the test runs in S5 together with
  the bundled care clips that the same test covers.
