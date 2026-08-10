import type { EsquemaCredencial } from '@geracrm/conectores'
import type { CapacidadesCanal } from './porta.js'
import { CAPACIDADES_PLUGZAPI } from './plugzapi.js'

/**
 * O catálogo de PROVEDORES de canal — a única lista (ADR-021).
 *
 * ⚠️ A tela de cadastro de celular desenha o formulário DAQUI, como a de ERP.
 * Um provedor não-oficial novo entra aqui e vira opção na tela sem tocar no
 * Angular — o console não conhece provedor nenhum.
 *
 * `oficial` prioriza a Meta; `nao_oficial` é opção com risco declarado. As
 * capacidades e o aviso viajam para a tela, que mostra o risco por caminho.
 */

export interface ProvedorCanal {
  readonly codigo: string
  readonly nome: string
  /** Tipo persistido em `canal_conectado.tipo`. */
  readonly tipo: 'whatsapp_oficial' | 'whatsapp_nao_oficial'
  readonly oficial: boolean
  readonly descricao: string
  readonly esquemaCredencial: EsquemaCredencial
  readonly capacidades: CapacidadesCanal
  /** ⚠️ Aviso mostrado na tela. Vazio no oficial; o de risco no não-oficial. */
  readonly aviso?: string
}

const CAP_OFICIAL: CapacidadesCanal = {
  janela24h: true, aceitaTemplate: true, riscoBanimento: false, textoLivreSempre: false,
}

export const CANAIS: readonly ProvedorCanal[] = [
  {
    codigo: 'meta_oficial',
    nome: 'WhatsApp Oficial (Meta)',
    tipo: 'whatsapp_oficial',
    oficial: true,
    descricao: 'API oficial do WhatsApp (Cloud API). Sem risco de banimento, com janela de 24h e templates.',
    capacidades: CAP_OFICIAL,
    esquemaCredencial: {
      preRequisito:
        'Requer o registro na Meta concluído (Business Manager verificado). O caminho recomendado é ' +
        'o Embedded Signup no onboarding; este cadastro manual é para quem já tem os dados da WABA.',
      campos: [
        { nome: 'telefone', rotulo: 'Número (com DDI)', tipo: 'texto', obrigatorio: true,
          ajuda: 'O número no formato 55DDNXXXXXXXX.', exemplo: '5581999999999' },
        { nome: 'wabaId', rotulo: 'WABA ID', tipo: 'texto', obrigatorio: true,
          ajuda: 'Business Manager → Contas do WhatsApp.' },
        { nome: 'phoneNumberId', rotulo: 'Phone Number ID', tipo: 'texto', obrigatorio: true,
          ajuda: 'O id do número na WABA — é por ele que o webhook identifica.' },
        { nome: 'token', rotulo: 'Token de acesso', tipo: 'senha', obrigatorio: true,
          ajuda: 'Token permanente do System User.' },
      ],
    },
  },
  {
    codigo: 'plugzapi',
    nome: 'PlugZapi (não-oficial)',
    tipo: 'whatsapp_nao_oficial',
    oficial: false,
    descricao: 'Integra um WhatsApp comum via PlugZapi/Z-API. Funciona sem o registro na Meta.',
    capacidades: CAPACIDADES_PLUGZAPI,
    // ⚠️ O aviso que a tela mostra em destaque — nunca silencioso (ADR-021).
    aviso:
      'API NÃO-oficial: automatiza um WhatsApp comum. Pode levar ao BANIMENTO do número pela Meta. ' +
      'Use um número que você aceite perder, e prefira o oficial quando o registro sair.',
    esquemaCredencial: {
      preRequisito:
        'Crie a instância no painel do PlugZapi e conecte o celular (leia o QR code). ' +
        'Pegue os dados em Credenciais e, em Segurança, o Token de segurança da conta.',
      campos: [
        { nome: 'instancia', rotulo: 'ID da instância', tipo: 'texto', obrigatorio: true,
          ajuda: 'Em Credenciais → ID da instância.' },
        { nome: 'token', rotulo: 'Token da instância', tipo: 'senha', obrigatorio: true,
          ajuda: 'Em Credenciais → Token da instância.' },
        { nome: 'clientToken', rotulo: 'Token de segurança (Client-Token)', tipo: 'senha', obrigatorio: true,
          ajuda: 'Em Segurança → Token de segurança da conta. Obrigatório se a conta o exige.' },
      ],
    },
  },
]

export function provedorPorCodigo(codigo: string): ProvedorCanal | undefined {
  return CANAIS.find((c) => c.codigo === codigo)
}
