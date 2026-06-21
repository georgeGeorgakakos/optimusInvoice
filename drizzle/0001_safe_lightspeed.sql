CREATE TABLE `configuration` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`softoneApiUrl` varchar(512),
	`softoneUsername` varchar(128),
	`softonePassword` text,
	`softoneClientId` varchar(128),
	`softoneAppId` varchar(128),
	`softoneCompany` varchar(128),
	`softoneBranch` varchar(128),
	`softoneModule` varchar(128),
	`softoneRefId` varchar(128),
	`fiscalYear` varchar(8) DEFAULT '2026',
	`connectionTested` int NOT NULL DEFAULT 0,
	`lastTestedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `configuration_id` PRIMARY KEY(`id`),
	CONSTRAINT `configuration_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `invoiceLineItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`supplierCode` varchar(128),
	`erpCode` varchar(128),
	`description` text,
	`quantity` varchar(32),
	`unitPrice` varchar(32),
	`discount1` varchar(32),
	`discount2` varchar(32),
	`discount3` varchar(32),
	`netAmount` varchar(32),
	`vatRate` varchar(32),
	`matchStatus` enum('matched','pending','manual','failed') NOT NULL DEFAULT 'pending',
	`matchConfidence` varchar(8),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceLineItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`supplierId` int,
	`invoiceNumber` varchar(128),
	`invoiceDate` timestamp,
	`totalAmount` varchar(32),
	`currency` varchar(8) DEFAULT 'EUR',
	`pdfUrl` text,
	`pdfFileKey` varchar(512),
	`status` enum('pending','processing','completed','failed','review_needed') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`extractedData` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`processedAt` timestamp,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productMappings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplierId` int NOT NULL,
	`supplierCode` varchar(128) NOT NULL,
	`erpCode` varchar(128) NOT NULL,
	`description` text,
	`price` varchar(32),
	`confidence` varchar(8) DEFAULT '100',
	`usageCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastUsed` timestamp,
	CONSTRAINT `productMappings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`erpCode` varchar(128) NOT NULL,
	`description` text,
	`price` varchar(32),
	`category` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_erpCode_unique` UNIQUE(`erpCode`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` text NOT NULL,
	`taxId` varchar(64),
	`address` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
	CONSTRAINT `suppliers_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `transformationRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplierId` int NOT NULL,
	`ruleType` enum('prefix_addition','suffix_addition','prefix_removal','suffix_removal','separator_removal','character_replacement','regex_pattern') NOT NULL,
	`pattern` varchar(256) NOT NULL,
	`confidence` varchar(8) NOT NULL DEFAULT '0',
	`usageCount` int NOT NULL DEFAULT 0,
	`successCount` int NOT NULL DEFAULT 0,
	`examples` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastUsed` timestamp,
	CONSTRAINT `transformationRules_id` PRIMARY KEY(`id`)
);
