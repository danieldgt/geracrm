import type { Sql } from '../../db/index.js'
import { carregarTemplateCampanha, type TemplateCampanha } from '../atendimento/envio-campanha.js'

/**
 * O CONTEÚDO DA CAMPANHA V2 cabe no canal escolhido? (F1, #74; ADR-021)
 *
 *   OFICIAL (Meta)   → template OBRIGATÓRIO: categoria MARKETING, versão APROVADA e todas
 *                      as variáveis do corpo mapeadas (`template.mapeamento_variaveis`, F2).
 *                      Texto livre não: fora da janela de 24h a Meta recusa, e campanha é
 *                      sempre fora da janela.
 *   NÃO OFICIAL      → texto livre, com `confirmaRiscoBanimento: true` (o risco do ADR-021
 *                      é decisão do cliente, e fica gravada). Template não: o canal não
 *                      envia template. O volume do dia é o teto de aquecimento do número.
 *   Instagram/TikTok → não fazem disparo em massa (skill geracrm-whatsapp-meta): recusa
 *                      explicando, em vez de deixar descobrir pelo erro.
 *
 * Revalidado no INICIAR (o template pode ter sido pausado pela Meta desde a criação).
 * Campanha LEGADA (sem canal) não passa por aqui — fica como está.
 */

export interface CanalCampanha {
  readonly id: string
  readonly tipo: string
  readonly nome: string
}

export interface ErroConteudo {
  readonly erro: string
  readonly mensagem: string
  readonly campos: Record<string, string>
  readonly faltando?: readonly number[]
}

export type ResultadoConteudo =
  | { ok: true; canal: CanalCampanha; template: TemplateCampanha | null }
  | { ok: false; e: ErroConteudo }

const falha = (erro: string, mensagem: string, campos: Record<string, string>, extra: Partial<ErroConteudo> = {}): ResultadoConteudo =>
  ({ ok: false, e: { erro, mensagem, campos, ...extra } })

export async function validarConteudo(
  tx: Sql,
  p: { canalId: string | null; templateId: string | null; mensagem: string | null; confirmaRiscoBanimento: boolean },
): Promise<ResultadoConteudo> {
  if (!p.canalId) return falha('campanha.canal_obrigatorio', 'Escolha o número que vai enviar.', { canalId: 'Obrigatório.' })
  const [canal] = await tx<{ id: string; tipo: string; nome: string; arquivado: boolean }[]>`
    SELECT id, tipo, nome_amigavel AS nome, (arquivado_em IS NOT NULL) AS arquivado
      FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${p.canalId}`
  if (!canal || canal.arquivado) return falha('campanha.canal_invalido', 'Número não encontrado ou removido da frota.', { canalId: 'Número inválido.' })
  const c: CanalCampanha = { id: canal.id, tipo: canal.tipo, nome: canal.nome }

  if (canal.tipo === 'whatsapp_oficial') {
    if (p.mensagem) {
      return falha('campanha.texto_livre_so_nao_oficial',
        'No número oficial a campanha sai por template aprovado; texto livre fora da janela de 24h a Meta recusa.',
        { mensagem: 'Use um template.' })
    }
    if (!p.templateId) return falha('campanha.template_obrigatorio', 'No número oficial, escolha um template de marketing aprovado.', { templateId: 'Obrigatório.' })
    const r = await carregarTemplateCampanha(tx, p.templateId)
    switch (r.estado) {
      case 'ok': return { ok: true, canal: c, template: r.template }
      case 'nao_encontrado': return falha('campanha.template_invalido', 'Template não encontrado.', { templateId: 'Template inválido.' })
      case 'categoria_invalida':
        return falha('campanha.template_categoria', `Campanha usa template de MARKETING; este é ${r.categoria}.`, { templateId: 'Categoria precisa ser MARKETING.' })
      case 'nao_aprovado': return falha('campanha.template_nao_aprovado', 'O template ainda não está aprovado pela Meta.', { templateId: 'Aguardando aprovação.' })
      case 'cabecalho_com_variavel':
        return falha('campanha.template_sem_mapeamento', 'O cabeçalho do template tem variável, e o envio de campanha só preenche o corpo.', { templateId: 'Tire a variável do cabeçalho.' })
      case 'sem_mapeamento':
        return falha('campanha.template_sem_mapeamento',
          `Mapeie as variáveis ${r.faltando.map((n) => `{{${n}}}`).join(', ')} do template antes de usá-lo em campanha.`,
          { templateId: 'Variáveis sem mapeamento.' }, { faltando: r.faltando })
    }
  }

  if (canal.tipo === 'whatsapp_nao_oficial') {
    if (p.templateId) return falha('campanha.template_so_oficial', 'O número não oficial não envia template; escreva o texto.', { templateId: 'Só no número oficial.' })
    if (!p.mensagem) return falha('campanha.invalida', 'Escreva o texto da campanha.', { mensagem: 'Obrigatório.' })
    if (!p.confirmaRiscoBanimento) {
      return falha('campanha.confirmacao_risco_necessaria',
        'Disparo em massa por número não oficial pode levar ao banimento do número. Confirme que está ciente do risco.',
        { confirmaRiscoBanimento: 'Confirme o risco.' })
    }
    return { ok: true, canal: c, template: null }
  }

  return falha('campanha.canal_nao_permite_campanha',
    'Este canal não faz disparo em massa (Instagram e TikTok limitam mensagens automáticas). Use um número de WhatsApp.',
    { canalId: 'Canal sem campanha.' })
}
