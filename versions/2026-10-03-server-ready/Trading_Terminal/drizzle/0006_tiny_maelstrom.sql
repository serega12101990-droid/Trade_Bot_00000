CREATE TABLE `scalping_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`status` text NOT NULL,
	`entry_price` real NOT NULL,
	`quantity` real NOT NULL,
	`notional` real NOT NULL,
	`stop_price` real NOT NULL,
	`target_price` real NOT NULL,
	`opened_at` integer NOT NULL,
	`entry_fee` real NOT NULL,
	`entry_mode` text NOT NULL,
	`validity` text DEFAULT 'VALID' NOT NULL,
	`invalid_reason` text,
	`signal_key` text,
	`signal_snapshot_json` text,
	`closed_at` integer,
	`exit_price` real,
	`pnl` real,
	`pnl_pct` real,
	`fees` real,
	`exit_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scalping_status_opened` ON `scalping_trades` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `idx_scalping_symbol_opened` ON `scalping_trades` (`symbol`,`opened_at`);--> statement-breakpoint
CREATE INDEX `idx_scalping_validity_closed` ON `scalping_trades` (`validity`,`closed_at`);