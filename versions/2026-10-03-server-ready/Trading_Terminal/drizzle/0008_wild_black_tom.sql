CREATE TABLE `scalping_observations` (
	`signal_key` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`captured_at` integer NOT NULL,
	`policy_version` text NOT NULL,
	`observation_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scalping_observations_time` ON `scalping_observations` (`captured_at`);