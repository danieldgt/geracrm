import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { TENANT, URL_ERP } from './ambiente.js'
import { api, enviosDaMeta, esperarAte, registroDe, tiposDeEvento, webhookEntrante } from './cliente.js'

/**
 * Fluxo ponta a ponta, na ORDEM em que o produto vive: webhook → agente → humano →
 * devolução → pedido. A API é um processo de verdade com workers ligados; Meta e
 * ERP são servidores falsos locais; IA é o vendedor de regras (`IA_PROVEDOR=simulado`).
 * Cada passo confere o estado observável PELA API (o banco só recebe a semente que
 * o ERP faria: a identidade externa do cliente).
 */
const PHONE_NUMBER_ID = 'PNID-E2E'
const WA_ID = '5585988887777'

interface Mensagem { id: string; direcao: string; tipo: string; conteudo: { texto?: string } }
interface ConversaDetalhe {
  id: string; contatoId: string; conduzidaPor: string
  atendimento: { estado: string; meu: boolean } | null; mensagens: Mensagem[]
}
interface ListaConversas { itens: { id: string; contatoId?: string }[] }

const dono = postgres(process.env.E2E_DATABASE_ADMIN_URL ?? '', { max: 1, onnotice: () => {} })
afterAll(async () => { await dono.end() })

const estado = { canalId: '', conversaId: '', contatoId: '', pedidoId: '', conexaoId: '' }

const conversa = async () => (await api<ConversaDetalhe>('GET', `/v1/conversas/${estado.conversaId}`)).corpo

let seq = 0
const inbound = (texto: string) => webhookEntrante({ phoneNumberId: PHONE_NUMBER_ID, waId: WA_ID, wamid: `wamid.E2E-IN-${(seq += 1)}`, texto })

describe('fluxo ponta a ponta', () => {
  it('0. a API está de pé e o número oficial (Meta) fica conectado, com o agente autônomo', async () => {
    expect((await api('GET', '/saude')).status).toBe(200)

    const criado = await api<{ id: string }>('POST', '/v1/canais', {
      provedor: 'meta_oficial', nomeAmigavel: 'Oficial E2E',
      credencial: { telefone: '558533330000', wabaId: 'WABA-E2E', phoneNumberId: PHONE_NUMBER_ID, token: 'token-e2e' },
    })
    expect(criado.status).toBe(201)
    estado.canalId = criado.corpo.id
    expect((await api('POST', `/v1/canais/${estado.canalId}/testar`)).status).toBe(200)

    const cfg = await api('PUT', `/v1/canais/${estado.canalId}/agente`, {
      modo: 'autonomo', confirmacao: 'autonomo',
      // Sem isto o portão cala o robô enquanto ninguém tiver recebido a resposta de ausência.
      soQuandoNinguemDisponivel: false, exigirAusenciaAntes: false,
      politicas: 'Loja de roupas. Entrega em todo o Brasil. Pagamento por Pix ou cartão.',
    })
    expect(cfg.status, JSON.stringify(cfg.corpo)).toBe(200)
  })

  it('1. webhook assinado da Meta cria contato e conversa', async () => {
    expect(await inbound('Oi, bom dia')).toBe(200)

    const achada = await esperarAte('conversa criada', async () => {
      const l = (await api<ListaConversas>('GET', '/v1/conversas')).corpo
      return l.itens?.[0]
    })
    estado.conversaId = achada.id
    const c = await conversa()
    estado.contatoId = c.contatoId
    expect(c.mensagens.some((m) => m.direcao === 'entrante' && m.conteudo.texto === 'Oi, bom dia')).toBe(true)
    expect((await api('GET', `/v1/contatos/${estado.contatoId}`)).status).toBe(200)
  })

  it('1b. o mesmo evento reenviado pela Meta é idempotente (não duplica a mensagem)', async () => {
    seq -= 1 // mesmo wamid do passo 1
    expect(await inbound('Oi, bom dia')).toBe(200)
    seq += 1
    const entrantes = (await conversa()).mensagens.filter((m) => m.direcao === 'entrante')
    expect(entrantes).toHaveLength(1)
  })

  it('2. o agente simulado, em modo autônomo, responde — e o envio chega ao canal falso', async () => {
    const envio = await esperarAte('envio do agente na Meta falsa', async () => (await enviosDaMeta())[0])
    expect(envio.para).toBe(WA_ID)
    expect(envio.texto.length).toBeGreaterThan(0)

    const c = await esperarAte('agente respondendo na conversa (conduzida pela IA)', async () => {
      const x = await conversa()
      return x.conduzidaPor === 'ia' && x.mensagens.some((m) => m.direcao === 'saliente') ? x : null
    })
    expect(c.conduzidaPor).toBe('ia')
    expect(c.mensagens.find((m) => m.direcao === 'saliente')?.conteudo.texto).toBe(envio.texto)
  })

  it('3. um vendedor assume a conversa e envia mensagem humana', async () => {
    const antes = (await enviosDaMeta()).length
    const assumiu = await api('POST', `/v1/conversas/${estado.conversaId}/assumir`, {})
    expect(assumiu.status, JSON.stringify(assumiu.corpo)).toBeLessThan(300)
    const c = await conversa()
    // `assumir` abre o atendimento (é ele que cala o agente: portão `humano_assumiu`).
    expect(c.atendimento).toMatchObject({ estado: 'em_atendimento', meu: true })

    const enviou = await api('POST', `/v1/conversas/${estado.conversaId}/mensagens`, { tipo: 'texto', texto: 'Oi! Aqui é o vendedor, já te ajudo.' })
    expect(enviou.status, JSON.stringify(enviou.corpo)).toBe(200)
    const envios = await esperarAte('envio humano na Meta falsa', async () => {
      const e = await enviosDaMeta()
      return e.length > antes ? e : null
    })
    // O gateway assina a mensagem humana com o nome do remetente (`*nome*` na 1ª linha).
    expect(envios.at(-1)?.texto).toContain('Oi! Aqui é o vendedor, já te ajudo.')
  })

  it('3b. com um humano conduzindo, o agente NÃO responde ao inbound', async () => {
    const antes = (await enviosDaMeta()).length
    expect(await inbound('Vocês têm camiseta?')).toBe(200)
    await esperarAte('inbound gravado', async () => (await conversa()).mensagens.some((m) => m.conteudo.texto === 'Vocês têm camiseta?'))
    await new Promise((ok) => setTimeout(ok, 4000)) // dá ao worker (varredura de 1 s + debounce) a chance de errar
    const depois = await enviosDaMeta()
    expect(depois.length, JSON.stringify(depois)).toBe(antes)
  })

  it('4. o vendedor devolve ao agente e o agente volta a responder ao próximo inbound', async () => {
    const dev = await api('POST', `/v1/conversas/${estado.conversaId}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(dev.status, JSON.stringify(dev.corpo)).toBe(200)
    const devolvida = await conversa()
    expect(devolvida.atendimento).toBeNull()
    expect(devolvida.conduzidaPor).toBe('ia')

    const antes = (await enviosDaMeta()).length
    expect(await inbound('Quero 2 camiseta verde g')).toBe(200)
    const envios = await esperarAte('resposta do agente após a devolução', async () => {
      const e = await enviosDaMeta()
      return e.length > antes ? e : null
    })
    expect(envios.at(-1)?.texto.length).toBeGreaterThan(0)
  })

  it('5. pedido assistido: rascunho → item do catálogo → resumo → "sim" do cliente → efetivação no ERP falso', async () => {
    // O agente (passo 4) pode ter criado o rascunho da conversa: o pedido é o MESMO por conversa.
    const criado = await api<{ id: string }>('POST', '/v1/pedidos', { contatoId: estado.contatoId, conversaId: estado.conversaId, novo: true, nome: 'Pedido E2E' })
    expect(criado.status).toBe(201)
    estado.pedidoId = criado.corpo.id

    const cat = await api<{ itens: { descricao: string; skus: { id: string; atributos: Record<string, string>; precoCentavos: number | null; saldo: number | null }[] }[] }>(
      'GET', '/v1/catalogo?busca=Camiseta%20b%C3%A1sica')
    const sku = cat.corpo.itens[0]?.skus.find((s) => s.precoCentavos !== null && (s.saldo ?? 0) > 2)
    expect(sku, 'catálogo semeado deve ter SKU com preço e saldo').toBeTruthy()

    const item = await api('POST', `/v1/pedidos/${estado.pedidoId}/itens`, { skuId: sku!.id, quantidade: 2 })
    expect(item.status, JSON.stringify(item.corpo)).toBe(200)
    const ped = await api<{ estado: string; totalCentavos: number; itens: unknown[] }>('GET', `/v1/pedidos/${estado.pedidoId}`)
    expect(ped.corpo.estado).toBe('rascunho')
    expect(ped.corpo.itens).toHaveLength(1)
    expect(ped.corpo.totalCentavos).toBe(2 * sku!.precoCentavos!)

    // Resumo ao cliente e o "sim" dele pelo webhook (a proposta vigente é do tenant, não da tela).
    const resumo = await api('POST', `/v1/pedidos/${estado.pedidoId}/enviar-resumo`)
    expect(resumo.corpo).toMatchObject({ ok: true })
    expect(await inbound('sim')).toBe(200)
    await esperarAte('pedido confirmado pelo cliente', async () => {
      const p = await api<{ estado: string }>('GET', `/v1/pedidos/${estado.pedidoId}`)
      return p.corpo.estado === 'confirmado'
    })
    expect(await tiposDeEvento()).toContain('pedido.confirmado')

    // ERP: conexão pela API; a identidade externa do cliente é o que a sincronização do ERP gravaria.
    const cx = await api<{ id: string }>('POST', '/v1/integracao/conexoes', {
      conector: 'geracloud', nomeAmigavel: 'ERP falso E2E', fonteDeVenda: true,
      credencial: { baseUrl: URL_ERP, usuario: 'integracao', senha: 'senha-e2e' },
    })
    expect(cx.status, JSON.stringify(cx.corpo)).toBe(201)
    estado.conexaoId = cx.corpo.id
    await dono`INSERT INTO contato_identidade_externa (tenant_id, sistema, id_externo, contato_id)
               VALUES (${TENANT}, ${'erp:' + estado.conexaoId}, 'CLI-E2E', ${estado.contatoId})`

    const ef = await api<{ ok: boolean; numeroExterno?: string; mensagem?: string }>('POST', `/v1/pedidos/${estado.pedidoId}/efetivar`)
    expect(ef.status, JSON.stringify(ef.corpo)).toBe(200)
    expect(ef.corpo.ok).toBe(true)
    expect((await api<{ estado: string }>('GET', `/v1/pedidos/${estado.pedidoId}`)).corpo.estado).toBe('efetivado')

    // O que o produto MANDOU ao ERP: o orçamento, com a chave de idempotência do pedido.
    const orcamento = (await registroDe('erp')).find((r) => r.caminho === '/catalogos-publico/orcamento')
    expect(orcamento, 'o ERP falso deve ter recebido o orçamento').toBeTruthy()
    expect(JSON.stringify(orcamento!.corpo)).toContain(estado.pedidoId)

    // Reefetivar é recusado, não duplica no ERP (o pedido já não é rascunho).
    expect((await api('POST', `/v1/pedidos/${estado.pedidoId}/efetivar`)).status).toBe(409)
    expect((await registroDe('erp')).filter((r) => r.caminho === '/catalogos-publico/orcamento')).toHaveLength(1)
  })
})
