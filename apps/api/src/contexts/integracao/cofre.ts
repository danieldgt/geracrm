import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import type { Credencial } from '@geracrm/conectores'

/**
 * Cifragem das credenciais de ERP.
 *
 * ⚠️ AES-256-GCM, não AES-CBC nem "criptografia simétrica" genérica. GCM é
 * AUTENTICADO: se o texto cifrado for alterado no banco, o decifrar FALHA em
 * vez de devolver lixo. Sem autenticação, um byte trocado vira uma senha
 * diferente que o ERP recusa — e o erro que aparece é "credencial inválida",
 * mandando a pessoa redigitar uma senha que estava certa.
 *
 * ⚠️ IV NOVO A CADA CIFRAGEM. Reusar IV com GCM não é uma fraqueza teórica: dois
 * textos cifrados com o mesmo par (chave, IV) revelam o XOR dos originais, e
 * quebram a autenticação. Por isso o IV é gerado aqui e viaja junto — ele não é
 * segredo, só precisa ser único.
 *
 * ⚠️ A chave vem do ambiente e NUNCA do banco. Chave guardada ao lado do dado
 * que ela protege não protege nada: quem tirou um dump do Postgres tirou os dois.
 *
 * Formato gravado em `conexao_erp.credenciais_cifradas`:
 *   [ versão 1B ][ IV 12B ][ tag 16B ][ texto cifrado ]
 * A versão existe para trocar de algoritmo depois sem precisar adivinhar o que
 * cada linha antiga é.
 */

const VERSAO = 1
const TAM_IV = 12
const TAM_TAG = 16

/**
 * Deriva a chave de 32 bytes do segredo do ambiente.
 *
 * ⚠️ SHA-256 do segredo, não o segredo cru: o valor do ambiente é texto de
 * comprimento livre, e `createCipheriv` exige exatamente 32 bytes. Truncar ou
 * completar com zeros — o atalho comum — descarta entropia sem avisar.
 */
function chave(): Buffer {
  const segredo = process.env.CREDENCIAL_CHAVE
  if (!segredo) {
    throw new Error(
      'CREDENCIAL_CHAVE não definida. Sem ela, credencial de ERP não pode ser gravada. ' +
        'Gere com: openssl rand -base64 48',
    )
  }
  // ⚠️ Falha alta e cedo, no boot, e não na hora em que o lojista clica em
  //    salvar: um segredo fraco em produção não é diferente de nenhum.
  if (segredo.length < 32) {
    throw new Error('CREDENCIAL_CHAVE curta demais — use pelo menos 32 caracteres.')
  }
  return createHash('sha256').update(segredo).digest()
}

export function cifrar(credencial: Credencial): Buffer {
  const iv = randomBytes(TAM_IV)
  const cifra = createCipheriv('aes-256-gcm', chave(), iv)
  const dados = Buffer.concat([
    cifra.update(JSON.stringify(credencial), 'utf8'),
    cifra.final(),
  ])
  return Buffer.concat([Buffer.from([VERSAO]), iv, cifra.getAuthTag(), dados])
}

export function decifrar(guardado: Buffer): Credencial {
  if (guardado.length < 1 + TAM_IV + TAM_TAG) {
    throw new Error('credencial cifrada truncada')
  }
  const versao = guardado[0]
  if (versao !== VERSAO) {
    throw new Error(`credencial cifrada na versão ${versao}, esta build entende ${VERSAO}`)
  }
  const iv = guardado.subarray(1, 1 + TAM_IV)
  const tag = guardado.subarray(1 + TAM_IV, 1 + TAM_IV + TAM_TAG)
  const dados = guardado.subarray(1 + TAM_IV + TAM_TAG)

  const decifra = createDecipheriv('aes-256-gcm', chave(), iv)
  decifra.setAuthTag(tag)
  // ⚠️ `final()` é quem verifica a tag. Sem chamá-lo, o conteúdo sai sem
  //    nenhuma checagem de integridade — e é exatamente o erro que faz um
  //    "AES-GCM" virar cifra sem autenticação na prática.
  const claro = Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8')
  return JSON.parse(claro) as Credencial
}

/**
 * O que a API devolve no lugar da credencial.
 *
 * ⚠️ A credencial ENTRA e nunca SAI (contrato-api §5.8). Nem mascarada com
 * asteriscos mostrando o tamanho, nem "só os 4 últimos": a tela não precisa
 * dela para nada — para trocar, a pessoa digita de novo. Devolver qualquer
 * pedaço transforma um XSS ou um log de resposta na senha do ERP do cliente.
 */
export interface CredencialResumo {
  readonly configurada: boolean
  /** Quais campos estão preenchidos — só os NOMES, nunca os valores. */
  readonly camposPreenchidos: readonly string[]
}

export function resumir(guardado: Buffer | null): CredencialResumo {
  if (!guardado) return { configurada: false, camposPreenchidos: [] }
  try {
    return { configurada: true, camposPreenchidos: Object.keys(decifrar(guardado)) }
  } catch {
    // ⚠️ Credencial que não decifra é tratada como não configurada, e a tela
    //    pede de novo. O caso real é rotação de chave: manter "configurada:
    //    true" faria a tela mostrar tudo certo enquanto nada funciona.
    return { configurada: false, camposPreenchidos: [] }
  }
}
