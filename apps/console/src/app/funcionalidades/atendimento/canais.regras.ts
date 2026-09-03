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
