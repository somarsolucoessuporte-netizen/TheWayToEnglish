import { connection } from "next/server";
import { getAllLessons } from "@/app-config/curriculum";
import TutorApp from "./TutorApp";

// Server entry for the student app: loads the curriculum (Supabase, JSON as
// fallback — see app-config/curriculum/index.ts) per request, so /admin
// edits show up without a redeploy, and hands it to the client app.
export default async function Page() {
  await connection();
  const lessons = await getAllLessons();
  return <TutorApp lessons={lessons} />;
}
