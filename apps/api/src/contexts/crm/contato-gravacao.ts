import type { Sql } from 'postgres'
import { apenasDigitos } from '@geracrm/shared'
import type { ContatoCadastro } from './contato-cadastro.js'

/**
 * Caminho de domínio ÚNICO de documento e endereço do contato: o PUT do cadastro (`rotas-contatos.ts`) e o
 * ganho do funil (`rotas-funil.ts`) gravam por aqui, com a regra da A1 (linha do ERP nunca é pisada).
 */

/**
 * Documento (CNPJ/CPF) e endereço de uma edição manual.
 *
 * ⚠️ Linha do ERP NUNCA é reescrita. A edição do usuário VENCE para exibição
 *    (ele corrigiu o dado): a linha manual vira a principal/fiscal e a do ERP é
 *    só DEMOVIDA (principal/fiscal = false), intacta, na mesma transação.
 *    A ingestão do ERP (`ingestao-clientes.ts`) só INSERE telefone/documento
 *    quando faltam e não toca em endereço — não re-promove sobre o manual.
 *    Reenviar o mesmo valor que o ERP já mostra (o formulário devolve tudo)
 *    não cria linha manual: seria um override sem mudança.
 *    Vazio remove só a linha manual; se sobrar linha do ERP sem principal, ela
 *    volta a ser a principal.
 */
interface EnderecoLinha {
  seq: number; logradouro: string | null; numero: string | null; complemento: string | null
  bairro: string | null; cidade: string | null; uf: string | null; cep: string | null
  principal: boolean; fonte: string
}

const trimOuNull = (x: string | null | undefined) => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null)

export async function gravarDocumento(tx: Sql, id: string, d: Pick<ContatoCadastro, 'documento'>): Promise<void> {
  const doc = d.documento ? apenasDigitos(d.documento) : null
  const linhas = await tx<{ seq: number; tipo: string; numero: string; fiscal: boolean; fonte: string }[]>`
    SELECT seq, tipo, numero, fiscal, fonte FROM contato_documento
     WHERE tenant_id = tenant_atual() AND contato_id = ${id} ORDER BY seq`
  const manual = linhas.find((l) => l.fonte === 'manual')

  if (!doc) {
    if (!manual) return
    await tx`DELETE FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${manual.seq}`
    const resto = linhas.filter((l) => l.seq !== manual.seq)
    if (resto.length > 0 && !resto.some((l) => l.fiscal)) {
      await tx`UPDATE contato_documento SET fiscal = true WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${resto[0]!.seq}`
    }
    return
  }

  const tipo = doc.length === 14 ? 'cnpj' : 'cpf'
  if (!manual) {
    const fiscalAtual = linhas.find((l) => l.fiscal)
    if (fiscalAtual && fiscalAtual.tipo === tipo && fiscalAtual.numero === doc) return // já é o que a ficha mostra
  }
  let seq: number
  if (manual) {
    seq = manual.seq
    await tx`UPDATE contato_documento SET fiscal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fiscal AND seq <> ${seq}`
    await tx`UPDATE contato_documento SET tipo = ${tipo}, numero = ${doc}, fiscal = true, visto_em = now()
              WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${seq}`
  } else {
    seq = Math.max(0, ...linhas.map((l) => l.seq)) + 1
    await tx`UPDATE contato_documento SET fiscal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fiscal`
    await tx`
      INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte)
      VALUES (tenant_atual(), ${id}, ${seq}, ${tipo}, ${doc}, true, 'manual')`
  }
}

export async function gravarEndereco(tx: Sql, id: string, d: Pick<ContatoCadastro, 'endereco'>): Promise<void> {
  const e = d.endereco
  const novo = {
    logradouro: trimOuNull(e?.logradouro), numero: trimOuNull(e?.numero), complemento: trimOuNull(e?.complemento),
    bairro: trimOuNull(e?.bairro), cidade: trimOuNull(e?.cidade), uf: trimOuNull(e?.uf),
    cep: e?.cep ? apenasDigitos(e.cep) : null,
  }
  const preenchido = Object.values(novo).some((x) => x !== null)
  const linhas = await tx<EnderecoLinha[]>`
    SELECT seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte FROM contato_endereco
     WHERE tenant_id = tenant_atual() AND contato_id = ${id} ORDER BY seq`
  const manual = linhas.find((l) => l.fonte === 'manual')

  if (!preenchido) {
    if (!manual) return
    await tx`DELETE FROM contato_endereco WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${manual.seq}`
    const resto = linhas.filter((l) => l.seq !== manual.seq)
    if (resto.length > 0 && !resto.some((l) => l.principal)) {
      await tx`UPDATE contato_endereco SET principal = true WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${resto[0]!.seq}`
    }
    return
  }

  if (!manual) {
    const principal = linhas.find((l) => l.principal)
    const igual = principal && (Object.keys(novo) as (keyof typeof novo)[]).every((k) => trimOuNull(principal[k]) === novo[k])
    if (igual) return // já é o que a ficha mostra
  }
  let seq: number
  if (manual) {
    seq = manual.seq
    await tx`UPDATE contato_endereco SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND principal AND seq <> ${seq}`
    await tx`
      UPDATE contato_endereco SET logradouro = ${novo.logradouro}, numero = ${novo.numero}, complemento = ${novo.complemento},
             bairro = ${novo.bairro}, cidade = ${novo.cidade}, uf = ${novo.uf}, cep = ${novo.cep}, principal = true
       WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${seq} AND fonte = 'manual'`
  } else {
    seq = Math.max(0, ...linhas.map((l) => l.seq)) + 1
    await tx`UPDATE contato_endereco SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND principal`
    await tx`
      INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte)
      VALUES (tenant_atual(), ${id}, ${seq}, ${novo.logradouro}, ${novo.numero}, ${novo.complemento},
              ${novo.bairro}, ${novo.cidade}, ${novo.uf}, ${novo.cep}, true, 'manual')`
  }
}

export async function gravarDocumentoEEndereco(tx: Sql, id: string, d: ContatoCadastro): Promise<void> {
  await gravarDocumento(tx, id, d)
  await gravarEndereco(tx, id, d)
}

