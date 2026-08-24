/**
 * ROTEAMENTO DO LEAD — quem atende: o agente ou uma pessoa.
 *
 * ⚠️ Vive em `packages/shared` (TS puro) porque é REGRA DE NEGÓCIO, e porque a
 * tela precisa **explicar a decisão** ao gestor com as mesmas palavras que a API
 * usou para tomá-la. Duplicar a régua no console faria a explicação divergir do
 * comportamento no primeiro ajuste.
 *
 * ⚠️ **O padrão é HUMANO.** Nenhuma combinação de entradas manda para o agente
 * sem uma regra que diga explicitamente que sim. Qualquer estado que não
 * reconhecemos cai na fila — é o comportamento seguro, não o de exceção.
 *
 * As regras são avaliadas EM ORDEM; a primeira que casar decide. A ordem não é
 * estética: kill switch precede tudo, e o cuidado com cliente valioso precede a
 * conveniência de automatizar.
 */

/**
 * O que o tenant autoriza o agente a fazer.
 *
 * ⚠️ Substitui a formulação "Rede A × Rede B" de AMK-014. A regra é a mesma, mas
 * expressa como **configuração do tenant** em vez do nosso organograma: um
 * cliente também pode preferir copiloto, e o domínio não precisa saber quem é a
 * Gera3 e quem é a loja.
 */
export type PoliticaAgente =
  /** O agente conversa sozinho (identificado como assistente). */
  | 'autonomo'
  /** O agente sugere; a pessoa envia. */
  | 'copiloto'
  /** Kill switch: o agente não assume nada. */
  | 'desligado'

/** Como o lead entrou — declarado na campanha (AMK-016). */
export type ModoEntrada = 'inbound_wa' | 'outbound_formulario'

export interface ContextoRoteamento {
  readonly politicaAgente: PoliticaAgente
  /** Da campanha que originou o lead. `null` quando não veio de anúncio. */
  readonly modoEntrada: ModoEntrada | null
  /** RFV no topo, ou histórico de compra relevante. */
  readonly clienteAltoValor: boolean
  /** Dono da carteira ativo, se houver. */
  readonly donoCarteiraId: string | null
  /** O assunto está fora do que o agente sabe responder. */
  readonly foraDoEscopo: boolean
  readonly veioDeAnuncio: boolean
  readonly foraDoExpediente: boolean
}

export type MotivoRoteamento =
  | 'agente_desligado'
  | 'campanha_outbound'
  | 'cliente_alto_valor'
  | 'tem_dono_de_carteira'
  | 'fora_do_escopo'
  | 'politica_copiloto'
  | 'lead_de_anuncio'
  | 'fora_do_expediente'
  | 'padrao_humano'

export interface DecisaoRoteamento {
  readonly destino: 'agente' | 'fila_humana'
  readonly motivo: MotivoRoteamento
  /** Número da regra que decidiu — para auditoria e para a tela explicar. */
  readonly regra: number
  /** Atendente a quem atribuir/notificar, quando há um dono claro. */
  readonly atribuirA: string | null
  /** Oferecer sugestão de IA ao atendente humano. */
  readonly copiloto: boolean
}

/** O texto que a tela mostra. Fica junto da regra para não divergir dela. */
export const EXPLICACAO: Record<MotivoRoteamento, string> = {
  agente_desligado: 'O agente está desligado para este número ou empresa.',
  campanha_outbound: 'A campanha usa formulário — nós iniciamos a conversa, então quem fala é uma pessoa.',
  cliente_alto_valor: 'Cliente de alto valor: vai direto para quem cuida dele.',
  tem_dono_de_carteira: 'Já tem responsável na carteira.',
  fora_do_escopo: 'O assunto está fora do que o agente responde.',
  politica_copiloto: 'Esta empresa usa o agente como copiloto: a pessoa envia.',
  lead_de_anuncio: 'Lead novo de anúncio, em conversa que ele mesmo iniciou.',
  fora_do_expediente: 'Fora do expediente — o agente atende e diz quando uma pessoa retoma.',
  padrao_humano: 'Sem regra que autorize o agente: fila humana.',
}

const humana = (
  motivo: MotivoRoteamento, regra: number,
  extra: { atribuirA?: string | null; copiloto?: boolean } = {},
): DecisaoRoteamento => ({
  destino: 'fila_humana',
  motivo,
  regra,
  atribuirA: extra.atribuirA ?? null,
  copiloto: extra.copiloto ?? false,
})

/**
 * Decide quem atende. Função total: **toda** entrada produz uma decisão, e a
 * ausência de regra aplicável produz fila humana (regra 9).
 */
export function rotearLead(ctx: ContextoRoteamento): DecisaoRoteamento {
  // 1 — Kill switch. ⚠️ Precede tudo: desligar tem de funcionar mesmo com todas
  //     as outras condições apontando para o agente.
  if (ctx.politicaAgente === 'desligado') return humana('agente_desligado', 1)

  // 2 — A campanha declarou outbound (AMK-016). ⚠️ O agente RESPONDE, nunca
  //     ABORDA: abordar em volume no canal não-oficial é o padrão que derruba
  //     número (AMK-014). Quem decide é a COLUNA, não a memória do operador.
  if (ctx.modoEntrada === 'outbound_formulario') return humana('campanha_outbound', 2)

  // 3 — ⚠️ Inegociável: cliente valioso nunca é triado por robô. O CRM sabe o RFV
  //     no instante da chegada — trocar a relação por um minuto de vendedora
  //     economizado é péssimo negócio.
  if (ctx.clienteAltoValor) {
    return humana('cliente_alto_valor', 3, { atribuirA: ctx.donoCarteiraId, copiloto: true })
  }

  // 4 — Já existe relação; robô no meio a quebra.
  if (ctx.donoCarteiraId !== null) {
    return humana('tem_dono_de_carteira', 4, { atribuirA: ctx.donoCarteiraId, copiloto: true })
  }

  // 5 — Limite de escopo declarado do agente.
  if (ctx.foraDoEscopo) return humana('fora_do_escopo', 5, { copiloto: true })

  // 6 — Política do tenant: copiloto sugere, pessoa envia.
  if (ctx.politicaAgente === 'copiloto') return humana('politica_copiloto', 6, { copiloto: true })

  // 7 — O caso de uso central: lead de anúncio, em conversa que ele iniciou.
  if (ctx.veioDeAnuncio) {
    return { destino: 'agente', motivo: 'lead_de_anuncio', regra: 7, atribuirA: null, copiloto: false }
  }

  // 8 — Anúncio roda 24/7, vendedora não. ⚠️ O agente declara a expectativa —
  //     diz quando uma pessoa retoma, não finge disponibilidade que não existe.
  if (ctx.foraDoExpediente) {
    return { destino: 'agente', motivo: 'fora_do_expediente', regra: 8, atribuirA: null, copiloto: false }
  }

  // 9 — ⚠️ O padrão. Não é "sobrou": é a decisão segura.
  return humana('padrao_humano', 9, { copiloto: true })
}
