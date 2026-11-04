import type { ConfigAgendaDoAgente } from '@geracrm/shared'

/**
 * Regras puras do bloco "Reuniões" em Agente › Configuração (raia C3). Sem DOM — testadas à parte.
 * A decisão de registrar a ferramenta é da API (`agendaNoTurno`); aqui a tela EXPLICA o efeito.
 */

/** Resposta de `GET /v1/canais/:id/agente/agenda`. */
export interface EstadoAgendaAgente extends ConfigAgendaDoAgente {
  readonly modoDoNumero: string
  readonly tipoCanal: string
}

/** O que a chave faz agora, dado o modo do número — a tela diz, não deixa a pessoa adivinhar. */
export function efeitoDaChave(reunioes: boolean, modoDoNumero: string): string {
  if (!reunioes) return 'Desligada: o agente não oferece nem marca reuniões. O botão "Agendar reunião" da conversa continua valendo para a equipe.'
  if (modoDoNumero === 'autonomo') return 'Ligada: o agente oferece horários livres e marca quando o cliente escolhe um deles.'
  if (modoDoNumero === 'assistido') return 'Ligada em modo assistido: o agente sugere os horários, mas quem marca é a pessoa (pelo botão da conversa).'
  return 'Ligada, mas sem efeito: o número está em sombra ou desligado. Ela passa a valer quando o número for para assistido ou autônomo.'
}

/** Sem template no oficial, o aviso fora da janela de 24 h é recusado — a tela avisa antes. */
export function avisoDeTemplates(tipoCanal: string, c: Pick<ConfigAgendaDoAgente, 'templateLembreteId' | 'templateReagendarId'>): string | null {
  if (tipoCanal !== 'whatsapp_oficial') return null
  const faltam = [c.templateLembreteId ? null : 'lembrete', c.templateReagendarId ? null : 'convite para remarcar'].filter(Boolean)
  if (faltam.length === 0) return null
  return `Sem template de ${faltam.join(' e de ')}, esse aviso não sai quando a última mensagem do cliente tiver mais de 24 h (regra da Meta)`
    + (c.templateReagendarId ? '.' : ' — e o no-show vai direto para uma pessoa.')
}

/** Os templates só fazem sentido no oficial (no não-oficial o aviso é texto, dentro da cota de aquecimento). */
export const mostraTemplates = (tipoCanal: string): boolean => tipoCanal === 'whatsapp_oficial'

/** Mudou algo em relação ao que o servidor tem? */
export function mudouAgenda(a: ConfigAgendaDoAgente, b: ConfigAgendaDoAgente): boolean {
  return a.reunioes !== b.reunioes || a.templateLembreteId !== b.templateLembreteId || a.templateReagendarId !== b.templateReagendarId
}

/** Corpo do PUT — exatamente o contrato da API (`.strict()`); vazio vira null. */
export const corpoAgendaAgente = (c: ConfigAgendaDoAgente): ConfigAgendaDoAgente => ({
  reunioes: c.reunioes, templateLembreteId: c.templateLembreteId || null, templateReagendarId: c.templateReagendarId || null,
})
