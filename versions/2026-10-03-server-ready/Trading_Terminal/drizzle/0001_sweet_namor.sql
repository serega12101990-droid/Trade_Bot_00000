CREATE TABLE `market_news` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`published_at` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`url` text NOT NULL,
	`source` text NOT NULL,
	`category` text NOT NULL,
	`sentiment` text NOT NULL,
	`sentiment_score` real NOT NULL,
	`relevance_score` real NOT NULL,
	`importance` text NOT NULL,
	`topics_json` text NOT NULL,
	`provider` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_market_news_symbol_url` ON `market_news` (`symbol`,`url`);--> statement-breakpoint
CREATE INDEX `idx_market_news_symbol_published` ON `market_news` (`symbol`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_market_news_fetched` ON `market_news` (`symbol`,`fetched_at`);