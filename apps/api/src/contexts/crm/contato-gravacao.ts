import type { Sql } from 'postgres'
import { apenasDigitos } from '@geracrm/shared'
import type { ContatoCadastro } from './contato-cadastro.js'

/**
 * Gravação de documento (CNPJ/CPF) e endereço principal de fonte 'manual'. Caminho de domínio ÚNICO:
 * o PUT do cadastro (`rotas-contatos.ts`) e o ganho do funil (`rotas-funil.ts`) gravam por aqui.
 * Só toca nas linhas manuais — o que veio do ERP não é pisado.
 */

/**
 * `substituirManual` (padrão): o documento manual vira exatamente o informado (vazio remove) — semântica
 * do PUT. Com `false` só ACRESCENTA o documento (o ganho não apaga um CPF manual que já estava lá).
 */
export async function gravarDocumento(tx: Sql, id: string, documento: string | null | undefined, substituirManual = true): Promise<void> {
  const doc = documento ? apenasDigitos(documento) : null
  if (substituirManual) {
    await tx`DELETE FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fonte = 'manual'`
  }
  if (!doc) return
  const tipo = doc.length === 14 ? 'cnpj' : 'cpf'
  const [{ prox } = { prox: 1 }] = await tx<{ prox: number }[]>`
    SELECT coalesce(max(seq), 0) + 1 AS prox FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id}`
  const [fiscal] = await tx`SELECT 1 FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fiscal`
  await tx`
    INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte)
    VALUES (tenant_atual(), ${id}, ${prox}, ${tipo}, ${doc}, ${!fiscal}, 'manual')`
}

export async function gravarEndereco(tx: Sql, id: string, e: ContatoCadastro['endereco']): Promise<void> {
  const preenchido = !!e && Object.values(e).some((x) => typeof x === 'string' && x.trim() !== '')
  if (!preenchido) {
    await tx`DELETE FROM contato_endereco WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = 1 AND fonte = 'manual'`
    return
  }
  const cep = e.cep ? apenasDigitos(e.cep) : null
  await tx`
    INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte)
    VALUES (tenant_atual(), ${id}, 1, ${e.logradouro ?? null}, ${e.numero ?? null}, ${e.complemento ?? null},
            ${e.bairro ?? null}, ${e.cidade ?? null}, ${e.uf ?? null}, ${cep}, true, 'manual')
    ON CONFLICT (tenant_id, contato_id, seq) DO UPDATE SET
      logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero, complemento = EXCLUDED.complemento,
      bairro = EXCLUDED.bairro, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, cep = EXCLUDED.cep`
}

export async function gravarDocumentoEEndereco(tx: Sql, id: string, d: ContatoCadastro): Promise<void> {
  await gravarDocumento(tx, id, d.documento)
  await gravarEndereco(tx, id, d.endereco)
}
