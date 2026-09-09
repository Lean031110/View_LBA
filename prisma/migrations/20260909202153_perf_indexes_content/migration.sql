-- CreateIndex
CREATE INDEX "Dish_active_order_idx" ON "Dish"("active", "order");

-- CreateIndex
CREATE INDEX "Log_createdAt_idx" ON "Log"("createdAt");

-- CreateIndex
CREATE INDEX "Promotion_active_order_idx" ON "Promotion"("active", "order");

-- CreateIndex
CREATE INDEX "Schedule_active_order_idx" ON "Schedule"("active", "order");

-- CreateIndex
CREATE INDEX "SocialLink_active_order_idx" ON "SocialLink"("active", "order");

-- CreateIndex
CREATE INDEX "TickerMessage_active_order_idx" ON "TickerMessage"("active", "order");
