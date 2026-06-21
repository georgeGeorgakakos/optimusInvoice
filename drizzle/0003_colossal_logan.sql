ALTER TABLE `invoiceLineItems` ADD `lineNumber` int;--> statement-breakpoint
ALTER TABLE `invoiceLineItems` ADD `unit` varchar(32);--> statement-breakpoint
ALTER TABLE `invoiceLineItems` ADD `vatAmount` varchar(32);--> statement-breakpoint
ALTER TABLE `invoiceLineItems` ADD `totalWithVat` varchar(32);