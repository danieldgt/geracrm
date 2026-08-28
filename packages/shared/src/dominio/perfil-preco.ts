/**
 * PERFIL DE PREÇO — varejo ou atacado (ADR-019).
 *
 * ⚠️ Mora em `shared` porque os três consumidores decidem a MESMA coisa: o
 * console tem o botão que troca o perfil na montagem do pedido, a API escolhe a
 * tabela do ERP a partir dele, e o app de campo vai pedir o mesmo. Antes disto o
 * literal `'atacado' | 'varejo'` estava repetido em cinco arquivos do console e
 * em dois da API — e união de literais duplicada é a que aceita um valor num
 * lugar e recusa no outro, sem ninguém perceber até o preço sair errado.
 */
export const PERFIS_PRECO = ['varejo', 'atacado'] as const

export type PerfilPreco = (typeof PERFIS_PRECO)[number]

/**
 * ⚠️ O padrão é ATACADO, e é decisão de produto, não conveniência: o caso
 * principal do CRM é venda B2B recorrente (ADR-019). Varejo é opt-in explícito.
 */
export const PERFIL_PRECO_PADRAO: PerfilPreco = 'atacado'

/**
 * Normaliza o que veio de fora — querystring, corpo de requisição, extração de
 * IA — para um perfil que o domínio reconhece.
 *
 * ⚠️ **Nunca devolve nulo, e nunca falha.** Cotar sempre acontece; o que muda é
 * com qual tabela. Valor desconhecido cai no padrão em vez de derrubar a busca
 * do catálogo — é o comportamento que as rotas já tinham (`=== 'varejo' ? … : …`)
 * e que a tela depende para o botão de perfil funcionar sem estado inválido.
 *
 * ⚠️ Quem precisa saber se o pedido era reconhecível — a extração do agente, que
 * não pode cotar atacado por engano — usa `ehPerfilPreco()` antes, e trata o
 * desconhecido como buraco a perguntar, não como padrão a assumir.
 */
export function perfilDeCotacao(bruto: string | null | undefined): PerfilPreco {
  const limpo = (bruto ?? '').trim().toLowerCase()
  return ehPerfilPreco(limpo) ? limpo : PERFIL_PRECO_PADRAO
}

/** O valor é um perfil declarado? Para quem precisa distinguir do padrão. */
export function ehPerfilPreco(bruto: string | null | undefined): bruto is PerfilPreco {
  return (PERFIS_PRECO as readonly string[]).includes((bruto ?? '').trim().toLowerCase())
}

/** Rótulo para tela e para texto de WhatsApp. */
export function rotuloPerfilPreco(perfil: PerfilPreco): string {
  return perfil === 'varejo' ? 'Varejo' : 'Atacado'
}
