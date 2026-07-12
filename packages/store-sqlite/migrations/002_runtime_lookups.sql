CREATE INDEX journal_records_act_trigger_event
ON journal_records(json_extract(entry_json, '$.act.input.triggerEventId'))
WHERE entry_kind = 'act.started';
