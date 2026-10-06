CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_preferences_revision_positive" CHECK ("user_preferences"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;