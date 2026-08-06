# The Way To English — Tutor IA de Inglês

Professora virtual de inglês com quem o aluno conversa por voz ou texto. Next.js + React + TypeScript.

## Rodando localmente

```bash
npm install
cp .env.example .env.local   # se ainda não existir
# edite .env.local e cole sua GROQ_API_KEY (crie uma em console.groq.com)
npm run dev
```

Abra http://localhost:3000.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GROQ_API_KEY` | sim | Chave da Groq usada pelo `GroqAIProvider` (rota `/api/chat`, server-side). |
| `GROQ_MODEL` | não | Default `llama-3.3-70b-versatile`. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | não | Só usadas se você ativar `ElevenLabsSpeechProvider` (rota `/api/tts`). Não ativado por padrão. |

Nunca reaproveite a chave de outro cliente/projeto — cada projeto tem sua própria chave.

## Arquitetura

```
src/
├── core/            # framework — não conhece branding nem regra de negócio
│   ├── avatar-engine/       # troca de sprite PNG com crossfade (setState/onAudioElement)
│   ├── character-state-machine/  # idle/listening/thinking/speaking/praise/correction/error
│   ├── speech/       # SpeechProvider (TTS): WebSpeechProvider (default), ElevenLabsSpeechProvider (pronto, inativo)
│   ├── stt/          # SpeechToTextProvider: BrowserSTTProvider (default)
│   ├── ai/           # AIProvider: GroqAIProvider (server), HttpAIProvider (client -> /api/chat)
│   └── conversation/ # orchestrator — único lugar que conhece STT+AI+TTS+state machine
├── app-config/       # tudo específico deste produto
│   ├── branding.ts   # nome, cores, textos
│   ├── persona.ts    # system prompt da professora (único ponto a editar o comportamento pedagógico)
│   └── providers.ts  # qual implementação concreta cada interface usa
├── components/       # UI (Avatar, ChatLog, CorrectionCard, MicButton, StatusPills)
└── app/              # rotas Next.js (App Router) + api/chat, api/tts
```

`core/` nunca importa de `app-config/`. Trocar de voz, por exemplo, é uma linha em
`src/app-config/providers.ts`:

```ts
export const speechProvider: SpeechProvider = new ElevenLabsSpeechProvider();
```

## Avatar

O avatar é composto por 9 sprites PNG (`public/avatar/*.png`, extraídos de um sprite sheet
gerado por IA) e uma troca com crossfade de opacidade (200ms) controlada por
`core/avatar-engine/AvatarEngine.ts`. Durante a fala, o quadro (`speaking-closed` →
`speaking-wide`) é escolhido pela amplitude do áudio via `AnalyserNode`; quando o
`SpeechProvider` ativo não expõe um elemento `<audio>` (caso do `WebSpeechProvider`
padrão, que usa a síntese nativa do navegador), o motor usa um ritmo sintético em vez de
travar num quadro só. As dimensões de cada sprite ficam em `public/avatar/avatar-manifest.json`,
importado estaticamente — o motor não precisa dar fetch nas imagens antes de renderizar.

Para trocar a arte do avatar: gere/edite os 9 PNGs mantendo os mesmos nomes de arquivo,
atualize `avatar-manifest.json` com as dimensões novas e copie tudo para `public/avatar/`.

## Persona

Editar `src/app-config/persona.ts` (`TUTOR_SYSTEM_PROMPT`) é o único ponto necessário para
mudar como a professora ensina. A resposta do modelo é sempre um JSON validado por Zod
(`core/ai/TutorResponse.ts`) com `speech` (o que é falado), e opcionalmente `correction`,
`praise` e `level`. Se o modelo devolver algo que não parseia como JSON válido, o texto cru
vira `speech` e a conversa segue — nunca quebra por erro de formato.

## Legado

`_legacy-techmassa/` guarda o código do projeto anterior (cliente Techmassa) só como
referência de comportamento durante a migração. Não é servido em produção e pode ser
removido quando não for mais necessário como referência.
