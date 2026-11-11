-- Skip agent output while seeking the latest input and turn boundaries.
CREATE INDEX IF NOT EXISTS messages_conversation_non_agent ON messages(conversation_id, id) WHERE sender != 'agent';
