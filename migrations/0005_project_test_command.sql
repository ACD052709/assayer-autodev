-- Trusted repository test command for coding-task workers (control-plane configured).

ALTER TABLE projects ADD COLUMN target_test_command TEXT;
