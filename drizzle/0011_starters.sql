-- #75 Starters and the open door: data only, no schema change. The five goals that map keep their slugs
-- (so nothing pointing at them moves); four starters are added; "reflection" goes, with any test-account
-- rows that point at it (no data to keep: those testers go back to onboarding). "something_else" stays
-- as the hidden off-list route and sorts last. Required on every starter: what, when, how_long; Get
-- fitter also where. The "what" note is what's worth learning, not a script.
INSERT INTO "goals" ("slug", "title", "description", "sort_order", "plan_questions") VALUES
	('ai', 'Put AI to work for you', 'Using AI tools for their work or life', 0, '[]'::jsonb),
	('side_project', 'Start something on the side', 'A side project or business: skills and steps, never money or investment advice', 0, '[]'::jsonb),
	('speak_connect', 'Speak & connect better', 'Networking, public speaking, everyday conversations; no dating, partner or family-conflict coaching', 0, '[]'::jsonb),
	('fun_skill', 'Learn a fun skill (Rubik''s cube, card trick, play a song, drawing)', 'A fun skill learnable in days to a couple of weeks, provable, nothing risky', 0, '[]'::jsonb);
--> statement-breakpoint
UPDATE "goals" AS g SET "title" = v."title", "description" = v."description", "sort_order" = v."sort_order", "plan_questions" = v."plan_questions"::jsonb
FROM (VALUES
	('ai', 'Put AI to work for you', 'Using AI tools for their work or life', 1,
		'[{"key":"what","required":true,"note":"their work and their interests; tasks they wish they could hand off or wish they had an assistant for; what they''ve tried with AI"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"AI tools or apps they already use"}]'),
	('reading', 'Read & learn more (books, ideas, any topic)', 'Books, articles, podcasts or any topic they want to learn', 2,
		'[{"key":"what","required":true,"note":"topics they''re into; something they''ve always wanted to learn but never had time for, or a book they''ve meant to read; books, articles or podcasts; how they like to learn"},{"key":"where","required":false},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"apps or tools they already use for it"}]'),
	('side_project', 'Start something on the side', 'A side project or business: skills and steps, never money or investment advice', 3,
		'[{"key":"what","required":true,"note":"whether they already have something in mind or want to find it together (never assume); what they''ve done so far; skills they bring"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"apps or tools they already use for it"}]'),
	('deep_work', 'Focus & get more done', 'Focused, distraction-free work on what matters to them', 4,
		'[{"key":"what","required":true,"note":"what they''re trying to get done; focus habits they wish they had; methods they''ve tried or use now; what pulls them off"},{"key":"where","required":false,"note":"where they work"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"apps or tools they already use for it, like a focus timer"}]'),
	('speak_connect', 'Speak & connect better', 'Networking, public speaking, everyday conversations; no dating, partner or family-conflict coaching', 5,
		'[{"key":"what","required":true,"note":"what they want to improve (networking, public speaking, everyday conversations); situations, or the kinds of people they want to talk to or connect with better; what feels hard"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"apps or tools they already use for it"}]'),
	('exercise', 'Get fitter', 'Gym, home workout, walk or run, a sport; beginner-safe, no medical advice', 6,
		'[{"key":"what","required":true,"note":"what they like and have done before; what they want to do; anything to work around"},{"key":"where","required":true,"note":"where, and whether they have a place already"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"any workout app or wearable they use"}]'),
	('nutrition', 'Eat better', 'Eating habits or a calorie or protein target; no cooking assumed, never invents restaurants', 7,
		'[{"key":"what","required":true,"note":"what a typical day looks like, and what they''d like it to look like; whether they like to cook or order; serious and tracked, or casual"},{"key":"when","required":true,"note":"when they''ll do the day''s step (a meal, prep or the day''s log)"},{"key":"how_long","required":true,"note":"minutes a day they can give it, for prep or logging"},{"key":"tracks_with","required":false,"note":"where they track it, if they do"}]'),
	('bedtime', 'Sleep better', 'Asleep at a set time; what keeps them up', 8,
		'[{"key":"what","required":true,"note":"what keeps them up, and what they want to change"},{"key":"when","required":true,"note":"the time they want to be asleep"},{"key":"how_long","required":true,"note":"the hours of sleep they want"},{"key":"tracks_with","required":false,"note":"a sleep app or wearable they already use"}]'),
	('fun_skill', 'Learn a fun skill (Rubik''s cube, card trick, play a song, drawing)', 'A fun skill learnable in days to a couple of weeks, provable, nothing risky', 9,
		'[{"key":"what","required":true,"note":"which skill; what they have for it (a cube, cards, an instrument)"},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false,"note":"apps or tools they already use for it"}]'),
	('something_else', 'Something else', 'Off-list: narrowed into a starter first; accepted only if ZOH can coach and check it daily', 10,
		'[{"key":"what","required":true},{"key":"where","required":false},{"key":"when","required":true},{"key":"how_long","required":true},{"key":"tracks_with","required":false}]')
) AS v("slug", "title", "description", "sort_order", "plan_questions")
WHERE g."slug" = v."slug";
--> statement-breakpoint
DELETE FROM "step_days" WHERE "plan_id" IN (SELECT "id" FROM "plans" WHERE "goal_slug" = 'reflection');--> statement-breakpoint
DELETE FROM "plans" WHERE "goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "plan_inputs" WHERE "goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "tester_goals" WHERE "goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "maintenance_checkins" WHERE "goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "suggestions" WHERE "goal_slug" = 'reflection' OR "new_goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "memory_pages" WHERE "goal_slug" = 'reflection';--> statement-breakpoint
UPDATE "testers" SET "goal_slug" = NULL, "phase" = 'onboarding' WHERE "goal_slug" = 'reflection';--> statement-breakpoint
DELETE FROM "goals" WHERE "slug" = 'reflection';
