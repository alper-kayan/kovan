-- "Your team's questions" is a push kind people turn on themselves: off on every phone so far.
UPDATE "push_devices" SET "muted" = "muted" || '["team"]'::jsonb WHERE NOT ("muted" ? 'team');
