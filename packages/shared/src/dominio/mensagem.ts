import { z } from 'zod'

/**
 * Contrato ÚNICO de conteúdo de mensagem — o envelope genérico que TODAS as
 * features de chat compartilham: texto, mídia (imagem/áudio/documento) e AÇÕES
 * (pedido, orçamento, cobrança…).
 *
 * ⚠️ Consumido por API, console e app ao mesmo tempo — mudou aqui, mudou nos
 * três. Discriminado por `tipo`: adicionar uma variante nova é adicionar um
 * membro à união, sem tocar em quem já consome as existentes. É o que deixa as
 * próximas funcionalidades "encaixarem" de forma padronizada.
 *
 * ⚠️ Mídia entra por REFERÊNCIA (`midiaId` no storage), nunca o binário — o
 * conteúdo vive no S3; o jsonb guarda o ponteiro.
 */

/** Opção clicável de um card de ação (Confirmar/Recusar…). */
export const opcaoAcao = z.object({ id: z.string(), rotulo: z.string() })
export type OpcaoAcao = z.infer<typeof opcaoAcao>

/** União discriminada do conteúdo, por `tipo` (espelha o CHECK da tabela mensagem). */
export const conteudoMensagem = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('texto'), texto: z.string().min(1) }),
  z.object({ tipo: z.literal('imagem'), midiaId: z.string(), mime: z.string(), legenda: z.string().optional() }),
  z.object({ tipo: z.literal('audio'), midiaId: z.string(), mime: z.string(), duracaoMs: z.number().int().nonnegative().optional() }),
  z.object({ tipo: z.literal('documento'), midiaId: z.string(), mime: z.string(), nome: z.string() }),
  z.object({
    tipo: z.literal('acao'),
    acao: z.string(), // 'pedido' | 'orcamento' | 'cobranca' | …
    titulo: z.string(),
    resumo: z.string().optional(),
    dados: z.record(z.string(), z.unknown()),
    opcoes: z.array(opcaoAcao),
    estado: z.enum(['pendente', 'confirmado', 'recusado', 'expirado']),
  }),
])
export type ConteudoMensagem = z.infer<typeof conteudoMensagem>
export type TipoMensagem = ConteudoMensagem['tipo']

/**
 * Entrada de ENVIO — o que a tela manda para a API. Hoje só texto está ligado no
 * envio; as demais variantes entram aqui conforme forem implementadas (o
 * envelope acima já as prevê).
 */
export const enviarMensagemEntrada = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('texto'), texto: z.string().min(1).max(4096) }),
  // imagem: `imagem` é URL ou data URL base64 (o adaptador aceita os dois).
  z.object({ tipo: z.literal('imagem'), imagem: z.string().min(1), legenda: z.string().max(1024).optional() }),
  // audio: `audio` é URL ou data URL base64 — vira mensagem de voz.
  z.object({ tipo: z.literal('audio'), audio: z.string().min(1) }),
])
export type EnviarMensagemEntrada = z.infer<typeof enviarMensagemEntrada>

/** Entrada para CRIAR um card de ação no chat (pedido, orçamento, cobrança…). */
export const criarAcaoEntrada = z.object({
  acao: z.string().min(1), // 'pedido' | 'orcamento' | …
  titulo: z.string().min(1),
  resumo: z.string().optional(),
  dados: z.record(z.string(), z.unknown()).default({}),
  opcoes: z.array(opcaoAcao).min(1),
})
export type CriarAcaoEntrada = z.infer<typeof criarAcaoEntrada>

/**
 * Resumo de UMA linha para a lista do inbox — genérico por tipo. Uma tela que
 * mostra "última mensagem" não precisa saber de cada variante; pergunta aqui.
 */
export function previewMensagem(tipo: string, conteudo: unknown): string {
  const c = (conteudo ?? {}) as Record<string, unknown>
  switch (tipo) {
    case 'texto':
      return typeof c['texto'] === 'string' ? (c['texto'] as string) : ''
    case 'imagem':
      return c['legenda'] ? `📷 ${String(c['legenda'])}` : '📷 Imagem'
    case 'audio':
      return '🎤 Áudio'
    case 'video':
      return '🎬 Vídeo'
    case 'documento':
      return `📎 ${c['nome'] ? String(c['nome']) : 'Documento'}`
    case 'acao':
      return `📋 ${c['titulo'] ? String(c['titulo']) : 'Ação'}`
    default:
      return `[${tipo}]`
  }
}
