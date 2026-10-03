ALTER TABLE `paper_trades` ADD `first_entry_time` integer;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `scale_in_count` integer DEFAULT 0 NOT NULL;