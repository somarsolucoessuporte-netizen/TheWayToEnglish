import { connection } from "next/server";
import { getAllLessons } from "@/app-config/curriculum";
import { DemoPage } from "@/demo/DemoPage";

// Rota de demo white-label multi-tenant: /demo/<escola>. Carrega o mesmo
// currículo do app de produção (ver app/page.tsx) e entrega ao wrapper de
// demo, que aplica a identidade visual da escola. Nenhuma rota de produção
// é alterada — esta rota apenas existe em paralelo.
export default async function DemoEscolaPage({
  params,
}: {
  params: Promise<{ escola: string }>;
}) {
  await connection();
  const { escola } = await params;
  const slug = decodeURIComponent(escola);
  const lessons = await getAllLessons();
  return <DemoPage slug={slug} lessons={lessons} />;
}
