-- Runs once, when the database volume is created: the test database beside the development one.
-- Each test file creates its own schema in ucap_test and drops it afterwards.
CREATE DATABASE ucap_test OWNER ucap;
