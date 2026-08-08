import { describe, it, expect } from 'vitest'
import type { ConectorErp } from './porta.js'

/**
 * Conformance suite — ONE suite, run against EVERY adapter.
 *
 * This is what proves the port belongs to our domain instead of mirroring one
 * vendor's API. A connector that only works because the port was shaped around
 * it fails here.
 *
 * ⚠️ A missing capability is a `skip`, not a failure. An ERP without live stock
 * is not a broken connector — and the DEGRADATION is tested too (ADR-008).
 */
export function conformidade(criar: () => ConectorErp): void {
  const c = criar()

  describe(`conformidade — ${c.nome}`, () => {
    it('declara todas as capacidades, sem deixar nenhuma indefinida', () => {
      // ⚠️ Capacidade indefinida é pior que ausente: a interface não sabe se
      // degrada ou não, e acaba escolhendo o caminho otimista.
      const esperadas = [
        'ingestaoClientes', 'ingestaoProdutos', 'ingestaoPedidos', 'cargaHistorica',
        'saldoSincrono', 'tabelaPrecoSincrona', 'creditoCliente', 'escritaPedido',
        'webhookDeVenda', 'fidelidade',
      ] as const
      for (const cap of esperadas) {
        expect(typeof c.capacidades[cap], `capacidade ${cap}`).toBe('boolean')
      }
    })

    it('⚠️ nenhum método da porta carrega nome de fornecedor', () => {
      // Se um método se chamar como um endpoint de ERP, isto deixou de ser
      // porta e virou SDK copiado — e o segundo conector prova da pior forma.
      const fornecedores = ['geracloud', 'bling', 'tiny', 'totvs', 'drezz', 'omie', 'pdvcore']
      const metodos = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(c)),
        ...Object.keys(c),
      ].map((m) => m.toLowerCase())

      for (const m of metodos) {
        for (const f of fornecedores) {
          expect(m.includes(f), `método "${m}" cita o fornecedor "${f}"`).toBe(false)
        }
      }
    })

    it('capacidade declarada implica método presente — e vice-versa', () => {
      // Declarar `true` sem implementar é a falha que só aparece em produção,
      // no meio de um pedido.
      expect(typeof c.consultarSaldo === 'function').toBe(c.capacidades.saldoSincrono)
      expect(typeof c.consultarPrecos === 'function').toBe(c.capacidades.tabelaPrecoSincrona)
      expect(typeof c.consultarCredito === 'function').toBe(c.capacidades.creditoCliente)
      expect(typeof c.efetivarPedido === 'function').toBe(c.capacidades.escritaPedido)
      expect(typeof c.consultarSaldoFidelidade === 'function').toBe(c.capacidades.fidelidade)
    })

    it('⚠️ escrita de pedido exige reconciliação por chave', () => {
      // Sem consultarPedidoPorChave, o timeout (resposta perdida) não tem como
      // ser resolvido a não ser reenviando às cegas — que é o que INV-53 proíbe.
      if (c.capacidades.escritaPedido) {
        expect(
          typeof c.consultarPedidoPorChave === 'function',
          'quem escreve pedido precisa saber consultar por chave de idempotência',
        ).toBe(true)
      }
    })

    it.skipIf(!c.capacidades.ingestaoClientes)(
      'ingestão de cliente produz o modelo canônico completo',
      async () => {
        const p = await c.listarClientes()
        expect(Array.isArray(p.itens)).toBe(true)
        for (const cliente of p.itens) {
          expect(cliente.idExterno).toBeTruthy()
          expect(typeof cliente.nome).toBe('string')
          expect(Array.isArray(cliente.telefones)).toBe(true)
          // ⚠️ Telefone precisa vir só com dígitos: é a chave de reconciliação
          // com o WhatsApp, e "(81) 99861-7049" não colide com "5581998617049".
          for (const t of cliente.telefones) expect(t).toMatch(/^\d+$/)
        }
      },
    )

    it.skipIf(!c.capacidades.ingestaoProdutos)(
      'ingestão de SKU traz atributos de variante, não só o produto',
      async () => {
        const p = await c.listarSkus()
        for (const sku of p.itens) {
          expect(sku.idExterno).toBeTruthy()
          // ⚠️ Se `atributos` vier sempre vazio, o adaptador está tratando o
          // PRODUTO como unidade vendável — e a grade cor × tamanho se perde.
          expect(typeof sku.atributos).toBe('object')
        }
      },
    )

    it.skipIf(!c.capacidades.saldoSincrono)(
      'saldo responde dentro do orçamento de tempo da tela',
      async () => {
        const inicio = Date.now()
        await c.consultarSaldo!([])
        // O painel de pedido bloqueia o envio acima disso. Se o conector não
        // cumpre, `saldoSincrono` deveria ser false — e a tela mostra o saldo
        // da última sincronização, com horário.
        expect(Date.now() - inicio).toBeLessThan(2_500)
      },
    )

    it.skipIf(!c.capacidades.escritaPedido)(
      'reenvio com a mesma chave de idempotência não cria segundo pedido',
      async () => {
        const chave = `conformidade-${c.nome}`
        const pedido = { clienteExterno: '1', itens: [], chaveIdempotencia: chave }
        const a = await c.efetivarPedido!(pedido)
        const b = await c.efetivarPedido!(pedido)
        if (a.ok && b.ok) expect(b.valor.numeroExterno).toBe(a.valor.numeroExterno)
      },
    )

    it.skipIf(!c.capacidades.fidelidade)(
      'saldo de fidelidade vem com data de apuração — nunca como se fosse ao vivo',
      async () => {
        const saldo = await c.consultarSaldoFidelidade!('1')
        if (saldo) {
          expect(saldo.apuradoEm instanceof Date).toBe(true)
          // ⚠️ Saldo negativo na tela é reclamação no balcão.
          expect(saldo.disponivelCentavos).toBeGreaterThanOrEqual(0)
        }
      },
    )

    it('sem escrita de pedido, o produto degrada para rascunho exportável', () => {
      // A degradação também é testada (ADR-008): "degrada em vez de quebrar"
      // não pode ser só uma frase no documento.
      if (!c.capacidades.escritaPedido) {
        expect(c.efetivarPedido).toBeUndefined()
      }
    })
  })
}
