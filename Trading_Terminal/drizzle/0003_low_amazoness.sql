ALTER TABLE `paper_accounts` ADD `entry_mode` text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_accounts` ADD `rub_per_usdt` real DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `entry_source` text DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `quote_currency` text DEFAULT 'USDT' NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `fx_rate` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `fees_native` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `realized_pnl_native` real;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `unrealized_pnl_native` real;