/**
 * Regras de apresentação do CRM (Leads) — puras, testáveis sem montar o
 * componente.
 */

/**
 * Há quanto tempo alguém falou com este lead.
 *
 * ⚠️ Numa coluna de centenas de cards iguais, a idade do último toque é o que
 * separa "ninguém tocou nisso" de "já estamos trabalhando". Sem ela, a única
 * forma de priorizar é abrir card por card.
 *
 * ⚠️ `null` vira "sem contato", nunca "hoje": lead que ninguém tocou é
 * exatamente o que a coluna precisa destacar.
 */
export function idadeToque(ultimoToqueEm: string | null | undefined, agora: Date): string {
  if (!ultimoToqueEm) return 'sem contato'
  const ms = agora.getTime() - new Date(ultimoToqueEm).getTime()
  if (Number.isNaN(ms)) return 'sem contato'
  // Relógio adiantado no servidor daria dia negativo; "hoje" é a leitura honesta.
  const dias = Math.floor(ms / 86_400_000)
  if (dias <= 0) return 'hoje'
  if (dias === 1) return 'ontem'
  if (dias < 30) return `há ${dias} d`
  const meses = Math.floor(dias / 30)
  return meses < 12 ? `há ${meses} m` : `há ${Math.floor(dias / 365)} a`
}

/**
 * O lead está sem responsável a ponto de merecer destaque?
 *
 * ⚠️ Só na coluna de QUALIFICADOS. Lead novo sem dono é o estado normal — pintar
 * de laranja os 709 cards da primeira coluna transforma a cor de atenção em cor
 * de fundo, e aí ela não avisa mais nada. Qualificado sem dono, sim: é trabalho
 * aprovado e parado.
 */
export function semDonoImporta(responsavel: string | null, coluna: string): boolean {
  return !responsavel && coluna === 'qualificado'
}
