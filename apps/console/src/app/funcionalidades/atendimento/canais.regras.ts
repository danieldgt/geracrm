/**
 * Regras de apresentação da tela de números — puras, para poderem ser testadas
 * sem montar componente.
 */

/**
 * A área avançada (credencial do fornecedor) fica FECHADA por padrão: no canal
 * não-oficial a instância pertence ao contrato da Drezz, e quem está conectando
 * o próprio WhatsApp não tem esses dados.
 *
 * ⚠️ Mas ela ABRE SOZINHA quando o servidor recusa um campo de credencial.
 * Erro apontando para campo escondido é erro invisível: a pessoa vê "Confira os
 * campos destacados" e não há campo destacado na tela.
 *
 * ⚠️ E por isso o clique não fecha enquanto houver erro — fechar esconderia
 * exatamente a mensagem que precisa ser lida.
 */
export function abrirAvancado(
  erros: Readonly<Record<string, string>>,
  camposCredencial: readonly string[],
  abertoManual: boolean,
): boolean {
  if (abertoManual) return true
  return camposCredencial.some((campo) => erros[campo] !== undefined)
}

/**
 * ⚠️ O passo do vigia é 5 min. Três passadas sem notícia significam que a
 * vigilância parou (processo reiniciando, fornecedor mudo, credencial quebrada)
 * — e é aí que "conectado" volta a ser lembrança, não observação.
 */
const MINUTOS_ATE_SUSPEITAR = 15

/**
 * Há quanto tempo o estado do canal foi OBSERVADO.
 *
 * ⚠️ `null` vira "nunca verificado", nunca "agora". Foi exatamente o que a
 * produção mostrou em 25/ago: `estado = 'conectado'` sem carimbo nenhum, escrito
 * no cadastro e jamais confirmado. Traduzir ausência de notícia como notícia boa
 * é o modo de falha que o carimbo existe para eliminar.
 */
export function idadeVerificacao(verificadoEm: string | null | undefined, agora: Date): string {
  if (!verificadoEm) return 'nunca verificado'
  const ms = agora.getTime() - new Date(verificadoEm).getTime()
  if (Number.isNaN(ms)) return 'nunca verificado'

  const minutos = Math.floor(ms / 60_000)
  // ⚠️ Relógio adiantado no servidor daria minuto negativo; "agora" é a leitura
  //    honesta disso, e nunca "há -3 min".
  if (minutos < 1) return 'verificado agora'
  if (minutos < 60) return `verificado há ${minutos} min`

  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `verificado há ${horas} h`
  return `verificado há ${Math.floor(horas / 24)} d`
}

/**
 * O carimbo está velho a ponto de merecer destaque?
 *
 * ⚠️ Serve para a tela mostrar "Conectado · verificado há 3 h" em cor de aviso:
 * o estado pode estar certo, mas ninguém confirmou. Sem isso o carimbo seria
 * decoração — a pessoa leria "Conectado" e não faria a conta.
 */
export function verificacaoAtrasada(verificadoEm: string | null | undefined, agora: Date): boolean {
  if (!verificadoEm) return true
  const ms = agora.getTime() - new Date(verificadoEm).getTime()
  if (Number.isNaN(ms)) return true
  return ms > MINUTOS_ATE_SUSPEITAR * 60_000
}

/** O que a edição envia ao servidor. Vazio = nada mudou. */
export interface MudancasDaEdicao {
  nomeAmigavel?: string
  credencial?: Record<string, string>
}

/**
 * O que efetivamente MUDOU numa edição de número.
 *
 * ⚠️ Campo de credencial em branco não é "apagar", é "mantém" — o servidor
 * mescla com o que já está guardado. Sem isso, corrigir um token errado exigiria
 * redigitar os outros, que quem chega com o canal quebrado raramente tem à mão.
 *
 * ⚠️ E o nome só viaja se foi editado: mandar sempre faria toda abertura do
 * modal virar uma alteração na trilha de auditoria sem nada ter mudado.
 */
export function mudancasDaEdicao(
  nome: string,
  nomeOriginal: string,
  credencial: Readonly<Record<string, string>>,
): MudancasDaEdicao {
  const preenchidos = Object.entries(credencial).filter(([, v]) => v.trim() !== '')
  return {
    ...(nome.trim() !== nomeOriginal ? { nomeAmigavel: nome.trim() } : {}),
    ...(preenchidos.length ? { credencial: Object.fromEntries(preenchidos) } : {}),
  }
}

/**
 * O texto do desfecho da remoção.
 *
 * ⚠️ "Removido" (apagado de vez) e "arquivado" (histórico de pé) são promessas
 * DIFERENTES, e a pessoa não tem como conferir qual das duas aconteceu. Juntar
 * as duas num "pronto!" apaga a única informação que ela não pode verificar
 * sozinha.
 */
export function avisoDeRemocao(
  nome: string,
  estado: 'removido' | 'arquivado',
  conversas: number,
): string {
  if (estado === 'removido') return `${nome} foi removido.`
  const preservadas = conversas === 1 ? '1 conversa preservada' : `${conversas} conversas preservadas`
  return `${nome} foi arquivado e saiu da frota. ${preservadas} no histórico.`
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING POR ESTADO (P10, playbook AM §2.7)
// ─────────────────────────────────────────────────────────────────────────────

/** Rápido enquanto há algo prestes a mudar (QR na tela, número conectando). */
export const POLL_RAPIDO_MS = 3_000
/** Lento no resto: o vigia observa a cada 5 min; mais que isso só gasta. */
export const POLL_LENTO_MS = 30_000

/**
 * Teto do modo rápido para um número `conectando` PARADO: se ninguém observou
 * nada novo nele (mesmo estado e mesmo `verificadoEm`) há mais que isto, ele
 * não está "prestes a mudar" — está esquecido, e 3 s para sempre só gasta.
 */
export const TETO_CONECTANDO_MS = 2 * 60_000

/** Recuo nas falhas seguidas do polling: 3 → 6 → 12 → 30 s. */
const RECUO_MS = [3_000, 6_000, 12_000, 30_000] as const

/** O que o polling precisa saber de cada número. */
export interface ObservacaoDoCanal {
  readonly estado: string
  /** Há quanto tempo o número está neste estado com o mesmo `verificadoEm`. */
  readonly paradoHaMs: number
}

/**
 * De quanto em quanto tempo a tela relê a frota.
 *
 * ⚠️ 3 s só enquanto ALGUÉM ESPERA: um QR aberto (aguardando a leitura) ou um
 * número `conectando` que ainda está se mexendo (até `TETO_CONECTANDO_MS`).
 * No resto, 30 s — polling rápido de fundo foi o que dominou o tráfego do
 * GeraCloud. Com falhas seguidas, recua (3→6→12→30 s) em vez de martelar um
 * servidor que já não responde. O polling para ao sair da tela (ngOnDestroy).
 */
export function intervaloDePolling(
  canais: readonly ObservacaoDoCanal[],
  aguardandoQr: boolean,
  falhasSeguidas = 0,
): number {
  if (falhasSeguidas > 0) return RECUO_MS[Math.min(falhasSeguidas, RECUO_MS.length) - 1]!
  if (aguardandoQr) return POLL_RAPIDO_MS
  const mexendo = canais.some((c) => c.estado === 'conectando' && c.paradoHaMs <= TETO_CONECTANDO_MS)
  return mexendo ? POLL_RAPIDO_MS : POLL_LENTO_MS
}

export type FalhaDeCarga = 'sem_permissao' | 'servidor_indisponivel' | 'erro'

/**
 * Classifica a falha ao ler a frota.
 *
 * ⚠️ "Servidor indisponível" é um estado PRÓPRIO, não um erro genérico: status
 * 0 (rede/servidor fora) e 502/503/504 (proxy sem quem responda). A ação é
 * outra — esperar, a tela tenta sozinha — e o dado na tela é de antes. Juntar
 * com "erro" faria a pessoa achar que o NÚMERO caiu quando quem caiu fomos nós.
 *
 * ⚠️ 5xx SEM corpo da API (`respondeuApi = false`) também é servidor fora: é
 * o proxy na frente dela respondendo por ela (o dev-server do Angular devolve
 * 500 em ECONNREFUSED). Um 500 com corpo nosso é erro de verdade.
 */
export function classificarFalhaDeCarga(status: number, respondeuApi = true): FalhaDeCarga {
  if (status === 403) return 'sem_permissao'
  if (status === 0 || status === 502 || status === 503 || status === 504) return 'servidor_indisponivel'
  if (status >= 500 && !respondeuApi) return 'servidor_indisponivel'
  return 'erro'
}

/** O corpo do erro veio da NOSSA API (forma `{erro}` ou o erro padrão do Fastify)? */
export function corpoDaApi(corpo: unknown): boolean {
  return typeof corpo === 'object' && corpo !== null && ('erro' in corpo || 'statusCode' in corpo)
}

/**
 * O que dizer quando o QR não vem.
 *
 * ⚠️ 409 traz motivo NOMEADO do servidor ("já conectada", "provedor sem QR").
 * 403 é papel: o QR é só do admin — e a tela diz a quem pedir, em vez de
 * "tente de novo" (que nunca vai funcionar). Servidor fora não é culpa do QR.
 */
export function mensagemFalhaQr(status: number, mensagemServidor?: string | null, respondeuApi = true): string {
  if (status === 409) return mensagemServidor || 'QR indisponível'
  if (status === 403) return 'Só o administrador da conta pode gerar o QR. Peça a ele para parear o aparelho.'
  if (classificarFalhaDeCarga(status, respondeuApi) === 'servidor_indisponivel') {
    return 'Servidor do GeraCRM indisponível. Tente de novo em instantes.'
  }
  return 'Não foi possível gerar o QR. Tente de novo.'
}

const ROTULOS_MODO:Readonly<Record<string, string>> = {
  desligado: 'Agente desligado',
  sombra: 'Agente em sombra',
  assistido: 'Agente assistido',
  autonomo: 'Agente autônomo',
}

/** Rótulo do modo do agente no número; modo desconhecido aparece cru, nunca some. */
export function rotuloModoAgente(modo: string | null | undefined): string {
  if (!modo) return 'Agente desligado'
  return ROTULOS_MODO[modo] ?? `Agente: ${modo}`
}
