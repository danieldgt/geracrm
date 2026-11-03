import { z } from 'zod'
import { normalizarTelefone, validarCnpj, validarCpf, apenasDigitos } from '@geracrm/shared'

/**
 * Corpo do cadastro completo do contato (POST/PUT /v1/contatos).
 *
 * ⚠️ Erro de validação é RETORNO tipificado POR CAMPO:
 *    `{ erro: 'validacao', mensagem, campos: { email: 'E-mail inválido' } }`
 *    — a tela põe a mensagem no campo certo. Texto vazio vira null (formulário
 *    manda '' para campo em branco); dinheiro em centavos inteiros.
 */

const UF = /^[A-Z]{2}$/

const vazioParaNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const textoOpc = (max: number, msg: string) =>
  z.preprocess(vazioParaNull, z.string().trim().max(max, msg).nullable().optional())

const endereco = z.object({
  cep: z.preprocess(vazioParaNull, z.string().refine((v) => apenasDigitos(v).length === 8, 'CEP inválido').nullable().optional()),
  logradouro: textoOpc(200, 'Logradouro muito longo'),
  numero: textoOpc(20, 'Número muito longo'),
  complemento: textoOpc(100, 'Complemento muito longo'),
  bairro: textoOpc(100, 'Bairro muito longo'),
  cidade: textoOpc(100, 'Cidade muito longa'),
  uf: z.preprocess(
    (v) => { const x = vazioParaNull(v); return typeof x === 'string' ? x.trim().toUpperCase() : x },
    z.string().regex(UF, 'UF inválida').nullable().optional(),
  ),
}).strict()

export const contatoCadastro = z.object({
  nome: z.string({ error: 'Informe o nome' }).trim().min(1, 'Informe o nome').max(200, 'Nome muito longo'),
  razaoSocial: textoOpc(200, 'Razão social muito longa'),
  nomeFantasia: textoOpc(200, 'Nome fantasia muito longo'),
  email: z.preprocess(vazioParaNull, z.string().trim().max(200, 'E-mail muito longo').email('E-mail inválido').nullable().optional()),
  telefone: z.string({ error: 'Informe o telefone' }).min(1, 'Informe o telefone')
    .refine((v) => normalizarTelefone(v) !== null, 'Telefone inválido. Use DDD + número'),
  whatsapp: z.boolean().optional(),
  /** CNPJ (14 dígitos) ou CPF (11), com ou sem máscara; o tipo sai do tamanho. */
  documento: z.preprocess(vazioParaNull, z.string().refine((v) => {
    const d = apenasDigitos(v)
    return d.length === 14 ? validarCnpj(d) : d.length === 11 ? validarCpf(d) : false
  }, 'CNPJ/CPF inválido').nullable().optional()),
  endereco: endereco.optional(),
  modalidade: z.preprocess(vazioParaNull, z.enum(['atacado', 'varejo'], { error: 'Modalidade inválida' }).nullable().optional()),
  prioridade: z.preprocess(vazioParaNull, z.enum(['baixa', 'media', 'alta', 'urgente'], { error: 'Prioridade inválida' }).nullable().optional()),
  temperatura: z.preprocess(vazioParaNull, z.enum(['frio', 'morno', 'quente'], { error: 'Temperatura inválida' }).nullable().optional()),
  origemId: z.preprocess(vazioParaNull, z.string().uuid('Origem inválida').nullable().optional()),
  valorEstimadoCentavos: z.preprocess(vazioParaNull,
    z.number({ error: 'Valor inválido' }).int('Valor deve ser em centavos inteiros').min(0, 'Valor não pode ser negativo')
      .max(Number.MAX_SAFE_INTEGER, 'Valor muito alto').nullable().optional()),
  observacoes: textoOpc(5000, 'Observações muito longas'),
})

export type ContatoCadastro = z.infer<typeof contatoCadastro>

/** Mensagem do campo documento conforme o que foi digitado. */
function mensagemDocumento(bruto: unknown): string {
  const n = typeof bruto === 'string' ? apenasDigitos(bruto).length : 0
  return n === 11 ? 'CPF inválido' : n === 14 ? 'CNPJ inválido' : 'CNPJ/CPF inválido'
}

export type ResultadoCadastro =
  | { ok: true; dados: ContatoCadastro }
  | { ok: false; campos: Record<string, string> }

/** Valida o corpo; devolve o mapa campo → mensagem (primeira mensagem de cada campo). */
export function validarCadastro(corpo: unknown): ResultadoCadastro {
  const r = contatoCadastro.safeParse(corpo ?? {})
  if (r.success) return { ok: true, dados: r.data }
  const campos: Record<string, string> = {}
  for (const issue of r.error.issues) {
    // 'endereco.cep' vira 'cep'; o resto fica pelo nome do campo de topo.
    const chave = issue.path[0] === 'endereco' && issue.path[1] !== undefined ? String(issue.path[1]) : String(issue.path[0] ?? 'corpo')
    if (campos[chave]) continue
    campos[chave] = chave === 'documento' ? mensagemDocumento((corpo as Record<string, unknown> | null)?.['documento']) : issue.message
  }
  return { ok: false, campos }
}
