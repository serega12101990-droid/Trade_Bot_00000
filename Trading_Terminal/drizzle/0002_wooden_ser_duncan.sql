CREATE TABLE `paper_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`initial_balance` real NOT NULL,
	`balance` real NOT NULL,
	`risk_per_trade_pct` real NOT NULL,
	`fee_bps` real NOT NULL,
	`slippage_bps` real NOT NULL,
	`max_open_positions` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`forecast_id` text NOT NULL,
	`model_version` text NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`timeframe` text NOT NULL,
	`side` text NOT NULL,
	`status` text NOT NULL,
	`signal_time` integer NOT NULL,
	`due_time` integer NOT NULL,
	`entry_time` integer,
	`exit_time` integer,
	`entry_price` real,
	`target_price` real NOT NULL,
	`stop_price` real NOT NULL,
	`exit_price` real,
	`quantity` real,
	`notional` real,
	`risk_amount` real,
	`fees` real DEFAULT 0 NOT NULL,
	`realized_pnl` real,
	`pnl_pct` real,
	`unrealized_pnl` real,
	`unrealized_pnl_pct` real,
	`last_price` real,
	`max_favorable_pct` real,
	`max_adverse_pct` real,
	`exit_reason` text,
	`last_processed_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecast_journal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_paper_trade_forecast` ON `paper_trades` (`forecast_id`);--> statement-breakpoint
CREATE INDEX `idx_paper_trade_status_signal` ON `paper_trades` (`status`,`signal_time`);--> statement-breakpoint
CREATE INDEX `idx_paper_trade_symbol_timeframe` ON `paper_trades` (`symbol`,`timeframe`,`signal_time`);