import { z } from 'zod'
import { normalizarDocumento } from '@geracrm/shared'

/**
 * VALIDAÇÃO DA EXTRAÇÃO — a fronteira entre o que o modelo ACHA que leu e o que
 * o produto aceita como verdade.
 *
 * ⚠️ **O que vem do modelo é entrada externa, como corpo de webhook.** E é pior
 * que a maioria delas: o modelo alucina campo BEM FORMATADO e errado com
 * facilidade — um CNPJ com catorze dígitos plausíveis que não existe, uma cidade
 * que ele deduziu do sotaque. Formato bonito é exatamente o que faz esse tipo de
 * erro passar por revisão humana.
 *
 * ⚠️ **Descartar é o comportamento normal, não o excepcional.** Por isso todo
 * descarte é registrado com motivo: a lista de descartados é a única medida
 * honesta de quanto o modelo está inventando, e é ela que diz se dá para
 * promover a extração para a fatia 2 (escrever no cadastro sozinho).
 */

export type TipoCompra = 'consumo_final' | 'revenda'

export interface CampoDescartado {
  readonly campo: string
  readonly valor: string
  readonly motivo: string
}

export interface ExtracaoValidada {
  readonly tipoCompra: TipoCompra | null
  readonly cidade: string | null
  readonly volume: string | null
  /** Só dígitos, e só se passou no dígito verificador. */
  readonly cnpj: string | null
  /** ⚠️ O que o modelo mandou e o produto recusou, com o porquê. */
  readonly descartados: readonly CampoDescartado[]
}

/** Campos que o esquema da ferramenta declara. Qualquer outro é invenção. */
const CAMPOS_PREVISTOS = ['tipoCompra', 'cidade', 'volume', 'cnpj'] as const

/**
 * ⚠️ Cidade não pode ter dígito e tem tamanho de nome de cidade. Sem isso, um
 * "não sei" ou um endereço inteiro entra no lugar do campo.
 */
const CIDADE = z.string().trim().min(2).max(60).regex(/^[^\d]+$/u)
const VOLUME = z.string().trim().min(1).max(80)
const TIPO_COMPRA = z.enum(['consumo_final', 'revenda'])

export function validarExtracao(bruto: Readonly<Record<string, unknown>>): ExtracaoValidada {
  const descartados: CampoDescartado[] = []
  const descartar = (campo: string, valor: unknown, motivo: string) => {
    descartados.push({ campo, valor: String(valor).slice(0, 60), motivo })
    return null
  }

  // ⚠️ Campo que o esquema não previu é invenção do modelo — não é ignorado em
  //    silêncio, é registrado. Modelo inventando campo é sinal de prompt ruim.
  for (const chave of Object.keys(bruto)) {
    if (!(CAMPOS_PREVISTOS as readonly string[]).includes(chave)) {
      descartar(chave, bruto[chave], 'campo não previsto no esquema')
    }
  }

  const texto = (chave: string): string | null => {
    const v = bruto[chave]
    if (v === undefined || v === null || v === '') return null
    if (typeof v !== 'string') return descartar(chave, v, 'não é texto')
    return v
  }

  let tipoCompra: TipoCompra | null = null
  const tc = texto('tipoCompra')
  if (tc !== null) {
    const r = TIPO_COMPRA.safeParse(tc)
    tipoCompra = r.success ? r.data : descartar('tipoCompra', tc, 'fora dos valores aceitos')
  }

  let cidade: string | null = null
  const cd = texto('cidade')
  if (cd !== null) {
    const r = CIDADE.safeParse(cd)
    cidade = r.success ? r.data : descartar('cidade', cd, 'não parece nome de cidade')
  }

  let volume: string | null = null
  const vl = texto('volume')
  if (vl !== null) {
    const r = VOLUME.safeParse(vl)
    volume = r.success ? r.data : descartar('volume', vl, 'vazio ou longo demais')
  }

  // ⚠️ O CAMPO MAIS PERIGOSO. Catorze dígitos plausíveis passam por qualquer
  //    revisão humana distraída — só o dígito verificador separa o que o cliente
  //    disse do que o modelo completou. Reaproveita a regra do domínio
  //    (packages/shared), a mesma que a importação de contatos usa.
  let cnpj: string | null = null
  const cn = texto('cnpj')
  if (cn !== null) {
    const normalizado = normalizarDocumento('cnpj', cn)
    cnpj = normalizado ?? descartar('cnpj', cn, 'dígito verificador não confere')
  }

  return { tipoCompra, cidade, volume, cnpj, descartados }
}

/**
 * Quantos dos seis sinais de qualificação (§4.1) já estão respondidos.
 *
 * ⚠️ Não decide nada: qualificação é decisão de negócio e, na fatia 1, é uma
 * PROPOSTA que uma pessoa aprova de manhã. Isto só conta buracos, para o agente
 * saber o que ainda falta perguntar — e para o resumo do handoff dizer em que pé
 * a conversa parou.
 */
export function sinaisPreenchidos(
  extraido: ExtracaoValidada,
  lead: { readonly jaEhCliente: boolean; readonly cidade: string | null; readonly temCnpj: boolean },
): readonly string[] {
  const tem: string[] = []
  if (lead.jaEhCliente) tem.push('historico')
  if (lead.cidade || extraido.cidade) tem.push('cidade')
  if (lead.temCnpj || extraido.cnpj) tem.push('cnpj')
  if (extraido.tipoCompra) tem.push('tipo_compra')
  if (extraido.volume) tem.push('volume')
  return tem
}
