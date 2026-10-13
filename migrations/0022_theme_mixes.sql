-- Themed mixes (Vietnamese, pop, love songs, ...) are kept in daily_mixes next to the four day-part ones: their
-- `daypart` holds a key such as "theme-vietnamese".
--  * cover: the song whose album cover stands for the mix on the home page and the car screen.
--  * rank: the order the mixes are shown in.
ALTER TABLE daily_mixes ADD COLUMN cover TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_mixes ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
