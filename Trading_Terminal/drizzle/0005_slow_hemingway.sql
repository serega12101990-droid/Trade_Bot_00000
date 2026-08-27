ALTER TABLE `paper_trades` ADD `entry_time_source` text DEFAULT 'TIMEFRAME_CANDLE' NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `exit_time_source` text;