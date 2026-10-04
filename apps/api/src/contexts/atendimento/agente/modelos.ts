import type { Sql } from '../../../db/index.js'
import { chaveQueFalta, type ProvedorLlm } from './fabrica-ferramentas.js'

/**
 * O CATÁLOGO DE MODELOS (0093) visto por um tenant — o que ele pode escolher
 * na tela do agente, e se o servidor consegue atender (chave do fornecedor).
 * Estudo e regras em docs/estudo-modelos-llm.md.
 */
export interface ModeloDoCatalogo {
  readonly codigo: string
  readonly provedor: ProvedorLlm
  readonly modelo: string
  readonly nome: string
  readonly descricao: string
  readonly gratuito: boolean
  readonly ferramentas: boolean
  readonly saidaEstruturada: boolean
  readonly qualidade: number
  readonly custoEntradaUsdMilhao: number
  readonly custoSaidaUsdMilhao: number
  readonly janelaContexto: number
  readonly observacao: string
  readonly padrao: boolean
  /** O servidor tem a chave deste fornecedor? */
  readonly disponivel: boolean
  readonly motivoIndisponivel: string | null
}

interface Linha {
  codigo: string; provedor: ProvedorLlm; modelo: string; nome: string; descricao: string; gratuito: boolean
  ferramentas: boolean; saida_estruturada: boolean; qualidade: number; custo_entrada_usd_milhao: string
  custo_saida_usd_milhao: string; janela_contexto: number; observacao: string; padrao_novos_tenants: boolean
  permitido: boolean | null
}

function montar(l: Linha, env: NodeJS.ProcessEnv): ModeloDoCatalogo {
  const falta = chaveQueFalta(l.provedor, env)
  return {
    codigo: l.codigo, provedor: l.provedor, modelo: l.modelo, nome: l.nome, descricao: l.descricao,
    gratuito: l.gratuito, ferramentas: l.ferramentas, saidaEstruturada: l.saida_estruturada, qualidade: l.qualidade,
    custoEntradaUsdMilhao: Number(l.custo_entrada_usd_milhao), custoSaidaUsdMilhao: Number(l.custo_saida_usd_milhao),
    janelaContexto: l.janela_contexto, observacao: l.observacao, padrao: l.padrao_novos_tenants,
    disponivel: falta === null, motivoIndisponivel: falta ? `falta ${falta} no servidor` : null,
  }
}

/**
 * Os modelos que ESTE tenant pode escolher. Com linhas em `tenant_modelo_ia`,
 * valem elas; sem nenhuma, valem os `padrao_novos_tenants`.
 */
export async function modelosPermitidos(tx: Sql, env: NodeJS.ProcessEnv = process.env): Promise<ModeloDoCatalogo[]> {
  const linhas = await tx<Linha[]>`
    WITH tem_regra AS (SELECT EXISTS (SELECT 1 FROM tenant_modelo_ia WHERE tenant_id = tenant_atual()) AS v)
    SELECT m.*, t.permitido
      FROM modelo_ia m
      LEFT JOIN tenant_modelo_ia t ON t.tenant_id = tenant_atual() AND t.modelo_codigo = m.codigo
     WHERE m.ativo
       AND CASE WHEN (SELECT v FROM tem_regra) THEN coalesce(t.permitido, false) ELSE m.padrao_novos_tenants END
     ORDER BY m.ordem, m.codigo`
  return linhas.map((l) => montar(l, env))
}

/** O catálogo inteiro com a marca do que está permitido para o tenant (tela do staff). */
export async function catalogoComPermissao(tx: Sql, env: NodeJS.ProcessEnv = process.env): Promise<(ModeloDoCatalogo & { permitido: boolean })[]> {
  const linhas = await tx<Linha[]>`
    WITH tem_regra AS (SELECT EXISTS (SELECT 1 FROM tenant_modelo_ia WHERE tenant_id = tenant_atual()) AS v)
    SELECT m.*, CASE WHEN (SELECT v FROM tem_regra) THEN coalesce(t.permitido, false) ELSE m.padrao_novos_tenants END AS permitido
      FROM modelo_ia m
      LEFT JOIN tenant_modelo_ia t ON t.tenant_id = tenant_atual() AND t.modelo_codigo = m.codigo
     WHERE m.ativo
     ORDER BY m.ordem, m.codigo`
  return linhas.map((l) => ({ ...montar(l, env), permitido: l.permitido === true }))
}

/** Substitui o conjunto permitido do tenant. Lista vazia = volta aos padrões (apaga as regras). */
export async function definirPermitidos(tx: Sql, codigos: readonly string[]): Promise<{ permitidos: string[]; desconhecidos: string[] }> {
  const validos = await tx<{ codigo: string }[]>`SELECT codigo FROM modelo_ia WHERE ativo AND codigo = ANY(${[...codigos]}::text[])`
  const ok = new Set(validos.map((v) => v.codigo))
  const desconhecidos = codigos.filter((c) => !ok.has(c))
  await tx`DELETE FROM tenant_modelo_ia WHERE tenant_id = tenant_atual()`
  if (ok.size > 0) {
    // Uma linha por modelo do catálogo: permitido para os escolhidos, negado para o resto —
    // assim "tem regra" fica inequívoco e um modelo novo no catálogo não entra sozinho.
    await tx`
      INSERT INTO tenant_modelo_ia (tenant_id, modelo_codigo, permitido)
      SELECT tenant_atual(), codigo, codigo = ANY(${[...ok]}::text[]) FROM modelo_ia WHERE ativo`
  }
  return { permitidos: [...ok], desconhecidos }
}

/** Resolve o código escolhido num canal para {provedor, modelo}, se permitido e ativo. */
export async function resolverModelo(tx: Sql, codigo: string | null | undefined): Promise<{ provedor: ProvedorLlm; modelo: string; codigo: string } | null> {
  if (!codigo) return null
  const permitidos = await modelosPermitidos(tx)
  const m = permitidos.find((p) => p.codigo === codigo)
  return m ? { provedor: m.provedor, modelo: m.modelo, codigo: m.codigo } : null
}
