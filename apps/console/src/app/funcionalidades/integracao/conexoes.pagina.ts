import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { ConexoesServico } from './conexoes.servico.js'
import { FormularioCredencialComponente } from './formulario-credencial.componente.js'
import { CAPACIDADES, MENSAGEM_FALHA, type Conexao, type ResultadoTeste } from './tipos.js'

/**
 * Configurações → ERP.
 *
 * ⚠️ A tela nunca nomeia fornecedor por conta própria: mostra `nomeAmigavel`.
 * Um cliente de outro ERP lendo "GeraCloud" na própria tela é bug visível (A-07).
 */
@Component({
  selector: 'app-conexoes-erp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormularioCredencialComponente, DatePipe],
  template: `
    <header class="cabecalho">
      <div>
        <h1>Integração com o ERP</h1>
        <p class="sub">
          É daqui que vêm seus clientes, produtos e vendas. Sem ele, o CRM começa vazio.
        </p>
      </div>
      @if (servico.estado() === 'pronto' && !servico.vazio()) {
        <button class="primario" (click)="abrirNovo()">Conectar outro ERP</button>
      }
    </header>

    <!-- ⚠️ Os cinco estados são ramos explícitos, não derivados do tamanho da
         lista: vazio-por-falha e vazio-por-não-ter pedem telas opostas. -->
    @switch (servico.estado()) {
      @case ('carregando') {
        <div class="bloco" aria-busy="true">
          <div class="esqueleto"></div><div class="esqueleto"></div>
        </div>
      }
      @case ('sem_permissao') {
        <div class="bloco aviso">
          <h2>Você não tem acesso às integrações</h2>
          <!-- Sem "tentar de novo": tentar de novo não vai funcionar nunca. -->
          <p>Peça a um administrador da sua empresa para liberar este acesso.</p>
        </div>
      }
      @case ('erro') {
        <div class="bloco aviso">
          <h2>Não foi possível carregar as integrações</h2>
          <p>{{ servico.erro() }}</p>
          <button (click)="servico.carregar()">Tentar de novo</button>
        </div>
      }
      @case ('pronto') {
        @if (servico.vazio()) {
          <div class="bloco vazio">
            <h2>Nenhum ERP conectado</h2>
            <p>
              Conecte seu ERP para trazer a base de clientes e o histórico de compras.
              É o que faz a recompra e o RFV funcionarem desde o primeiro dia.
            </p>
            <button class="primario" (click)="abrirNovo()">Conectar meu ERP</button>
          </div>
        } @else {
          <ul class="lista">
            @for (conexao of servico.conexoes(); track conexao.id) {
              <li class="conexao" [class]="'conexao--' + conexao.estado">
                <div class="linha">
                  <div>
                    <!-- Nunca o código do conector. -->
                    <h2>{{ conexao.nomeAmigavel }}</h2>
                    @if (conexao.identificacaoRemota; as remota) {
                      <!-- ⚠️ Único jeito de a pessoa notar que conectou na loja errada. -->
                      <p class="remota">Conectado em: <strong>{{ remota }}</strong></p>
                    }
                  </div>
                  <span class="selo">{{ rotuloEstado(conexao) }}</span>
                </div>

                @if (conexao.estado === 'com_erro' && conexao.ultimoErroMotivo; as motivo) {
                  <div class="falha">
                    <strong>{{ mensagem(motivo).titulo }}</strong>
                    <p>{{ mensagem(motivo).acao }}</p>
                    @if (conexao.ultimoErro) { <p class="detalhe">{{ conexao.ultimoErro }}</p> }
                  </div>
                }

                <dl class="datas">
                  <div>
                    <dt>Última validação</dt>
                    <dd>{{ conexao.ultimaValidacaoEm ? (conexao.ultimaValidacaoEm | date: 'short') : 'nunca' }}</dd>
                  </div>
                  @if (tentandoEFalhando(conexao)) {
                    <!-- ⚠️ A distância entre as duas datas é o sinal: validação
                         velha com tentativa recente = está tentando e falhando. -->
                    <div class="alerta">
                      <dt>Última tentativa</dt>
                      <dd>{{ conexao.ultimaTentativaEm | date: 'short' }}</dd>
                    </div>
                  }
                </dl>

                <!-- ⚠️ Degradação VISÍVEL (ADR-008): a tela diz o que o produto
                     deixa de fazer, com a consequência — não a capacidade que falta. -->
                @if (faltantes(conexao).length > 0) {
                  <details class="degradacao">
                    <summary>
                      {{ faltantes(conexao).length }} recurso(s) que este ERP não oferece
                    </summary>
                    <ul>
                      @for (c of faltantes(conexao); track c.chave) {
                        <li><strong>{{ c.rotulo }}:</strong> {{ c.ausente }}</li>
                      }
                    </ul>
                  </details>
                }

                <div class="acoes">
                  <button (click)="testar(conexao)" [disabled]="servico.testando().has(conexao.id)">
                    {{ servico.testando().has(conexao.id) ? 'Testando…' : 'Testar conexão' }}
                  </button>
                  <button (click)="abrirCredencial(conexao)">
                    {{ conexao.credencial.configurada ? 'Trocar credenciais' : 'Preencher credenciais' }}
                  </button>
                </div>

                @if (resultado()[conexao.id]; as r) {
                  <p class="resultado" [class.resultado--ok]="r.ok" role="status">
                    @if (r.ok) {
                      Conexão funcionando{{ r.identificacao ? ' — ' + r.identificacao : '' }}.
                    } @else {
                      {{ mensagem(r.motivo).titulo }}. {{ mensagem(r.motivo).acao }}
                    }
                  </p>
                }
              </li>
            }
          </ul>
        }
      }
    }

    <!-- INT-08: o que cada sincronização trouxe e rejeitou. Estado PARCIAL da
         tela — some sozinho se a carga nunca rodou, sem derrubar as conexões. -->
    @if (servico.operacoes().length) {
      <section class="sync">
        <h2 class="sync-titulo">Últimas sincronizações</h2>
        <table class="sync-tabela">
          <thead>
            <tr><th>Fluxo</th><th>Lidos</th><th>Aceitos</th><th>Rejeitados</th><th>Quando</th></tr>
          </thead>
          <tbody>
            @for (op of servico.operacoes(); track op.iniciadoEm + op.fluxo) {
              <tr>
                <td>{{ rotuloFluxo(op.fluxo) }}</td>
                <td class="num">{{ op.total }}</td>
                <td class="num">{{ op.aceitos }}</td>
                <!-- Rejeição é sinal de conciliação, não erro fatal: destaca só quando há. -->
                <td class="num" [class.num--alerta]="op.rejeitados > 0">{{ op.rejeitados }}</td>
                <td>{{ (op.concluidoEm ?? op.iniciadoEm) | date: 'dd/MM HH:mm' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    }

    @if (editando(); as ed) {
      <div class="painel" role="dialog" aria-modal="true" aria-labelledby="titulo-painel">
        <h2 id="titulo-painel">
          {{ ed.conexaoId ? 'Trocar credenciais' : 'Conectar ERP' }}
        </h2>

        @if (!ed.conexaoId) {
          <label class="campo">
            <span class="rotulo">Qual é o seu ERP?</span>
            <select [value]="ed.conector" (change)="trocarConector($event)">
              @for (c of servico.conectores(); track c.codigo) {
                <option [value]="c.codigo">{{ c.nome }}</option>
              }
            </select>
            <span class="ajuda">{{ conectorAtual()?.descricao }}</span>
          </label>

          <label class="campo">
            <span class="rotulo">Como chamar esta conexão</span>
            <input [value]="ed.nome" (input)="nomeMudou($event)" placeholder="ERP da matriz" />
            <!-- ⚠️ Este nome aparece em toda mensagem de erro do produto. -->
            <span class="ajuda">
              {{ erros()['nomeAmigavel']
                 ?? 'Aparece nas mensagens do sistema — "o ERP da matriz não respondeu".' }}
            </span>
          </label>
        }

        @if (conectorAtual(); as conector) {
          <app-formulario-credencial
            [esquema]="conector.esquemaCredencial"
            [erros]="erros()"
            (mudou)="credencialMudou($event)"
          />
        }

        @if (erroGeral(); as msg) { <p class="erro-geral" role="alert">{{ msg }}</p> }

        <div class="acoes">
          <button (click)="fechar()">Cancelar</button>
          <button class="primario" (click)="salvar()" [disabled]="salvando()">
            {{ salvando() ? 'Salvando…' : 'Salvar e testar' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; max-width: 720px; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-6); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .vazio, .aviso { text-align: center; }
    .esqueleto { height: 72px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-3); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-4); }
    .conexao { padding: var(--espacamento-4); border: 1px solid var(--borda); border-left: var(--densidade-acento-lateral-card, 3px) solid var(--borda-forte); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .conexao--ativa { border-left-color: var(--ativo); }
    .conexao--com_erro { border-left-color: var(--erro); }
    .conexao--configurando { border-left-color: var(--atencao); }
    .linha { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-3); }
    .conexao h2 { margin: 0; font-size: 15px; color: var(--texto); }
    .remota { margin: var(--espacamento-1) 0 0; font-size: 13px; color: var(--texto-secundario); }
    .selo { font-size: 12px; color: var(--texto-secundario); white-space: nowrap; }
    .falha { margin-top: var(--espacamento-3); padding: var(--espacamento-3); border-radius: var(--raio-controle); background: var(--superficie); border-left: 3px solid var(--erro); }
    .falha strong { color: var(--texto); font-size: 14px; }
    .falha p { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 13px; }
    .detalhe { font-family: var(--tipografia-familia-dados); font-size: 12px !important; color: var(--texto-suave) !important; }
    .datas { display: flex; gap: var(--espacamento-6); margin: var(--espacamento-3) 0 0; }
    .datas div { display: grid; gap: 2px; }
    dt { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    dd { margin: 0; font-size: 13px; color: var(--texto-secundario); font-family: var(--tipografia-familia-dados); }
    .alerta dd { color: var(--atencao); }
    .degradacao { margin-top: var(--espacamento-3); font-size: 13px; }
    .degradacao summary { cursor: pointer; color: var(--texto-secundario); }
    .degradacao ul { margin: var(--espacamento-2) 0 0; padding-left: var(--espacamento-4); color: var(--texto-secundario); line-height: 1.6; }
    .acoes { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-4); }
    button { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    .primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .resultado { margin: var(--espacamento-3) 0 0; font-size: 13px; color: var(--erro); }
    .resultado--ok { color: var(--sucesso); }
    .painel { margin-top: var(--espacamento-6); padding: var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); box-shadow: var(--elevacao-modal); }
    .painel h2 { margin: 0 0 var(--espacamento-4); font-size: 16px; }
    .campo { display: grid; gap: var(--espacamento-1); margin-bottom: var(--espacamento-4); }
    .rotulo { font-weight: 500; font-size: 13px; color: var(--texto); }
    .ajuda { font-size: 12px; color: var(--texto-suave); }
    select, .campo input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro-geral { color: var(--erro); font-size: 13px; }
    .sync { margin-top: var(--espacamento-6); }
    .sync-titulo { margin: 0 0 var(--espacamento-3); font-size: 15px; color: var(--texto); }
    .sync-tabela { width: 100%; border-collapse: collapse; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .sync-tabela th, .sync-tabela td { padding: var(--espacamento-2) var(--espacamento-3); text-align: left; font-size: 13px; border-bottom: 1px solid var(--borda); }
    .sync-tabela th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); font-weight: 500; }
    .sync-tabela tr:last-child td { border-bottom: none; }
    .sync-tabela td { color: var(--texto-secundario); }
    .num { text-align: right; font-family: var(--tipografia-familia-dados); }
    .num--alerta { color: var(--atencao); }
  `,
})
export class ConexoesPagina implements OnInit {
  readonly servico = inject(ConexoesServico)

  readonly editando = signal<{ conexaoId?: string; conector: string; nome: string } | null>(null)
  readonly credencial = signal<Record<string, string>>({})
  readonly erros = signal<Record<string, string>>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)
  readonly resultado = signal<Record<string, ResultadoTeste>>({})

  readonly conectorAtual = computed(() => {
    const ed = this.editando()
    return ed ? this.servico.conectores().find((c) => c.codigo === ed.conector) : undefined
  })

  ngOnInit(): void {
    void this.servico.carregar()
    void this.servico.carregarOperacoes()
  }

  mensagem(motivo: keyof typeof MENSAGEM_FALHA) { return MENSAGEM_FALHA[motivo] }

  rotuloFluxo(fluxo: string): string {
    switch (fluxo) {
      case 'customers': return 'Clientes'
      case 'products': return 'Produtos'
      case 'orders': return 'Vendas'
      default: return fluxo
    }
  }

  rotuloEstado(c: Conexao): string {
    switch (c.estado) {
      case 'ativa': return 'Funcionando'
      case 'com_erro': return 'Com problema'
      case 'pausada': return 'Pausada'
      // ⚠️ "Aguardando teste", não "Configurando": diz o que FALTA fazer.
      default: return c.credencial.configurada ? 'Aguardando teste' : 'Falta credencial'
    }
  }

  /** Validação velha + tentativa recente = está tentando e falhando. */
  tentandoEFalhando(c: Conexao): boolean {
    if (!c.ultimaTentativaEm) return false
    if (!c.ultimaValidacaoEm) return true
    return new Date(c.ultimaTentativaEm) > new Date(c.ultimaValidacaoEm)
  }

  faltantes(c: Conexao) {
    return CAPACIDADES.filter((cap) => c.capacidades[cap.chave] === false)
  }

  abrirNovo(): void {
    const primeiro = this.servico.conectores()[0]
    this.limpar()
    this.editando.set({ conector: primeiro?.codigo ?? '', nome: '' })
  }

  abrirCredencial(c: Conexao): void {
    this.limpar()
    this.editando.set({ conexaoId: c.id, conector: c.conector, nome: c.nomeAmigavel })
  }

  fechar(): void { this.editando.set(null); this.limpar() }

  private limpar(): void {
    this.credencial.set({})
    this.erros.set({})
    this.erroGeral.set(null)
  }

  trocarConector(evento: Event): void {
    const conector = (evento.target as HTMLSelectElement).value
    // ⚠️ Troca de ERP limpa a credencial: os campos são outros, e manter o que
    //    foi digitado enviaria um campo que não pertence a este ERP.
    this.credencial.set({})
    this.erros.set({})
    this.editando.update((ed) => (ed ? { ...ed, conector } : ed))
  }

  nomeMudou(evento: Event): void {
    const nome = (evento.target as HTMLInputElement).value
    this.editando.update((ed) => (ed ? { ...ed, nome } : ed))
  }

  credencialMudou(valores: Record<string, string>): void {
    this.credencial.set(valores)
  }

  async salvar(): Promise<void> {
    const ed = this.editando()
    if (!ed) return
    this.salvando.set(true)
    this.erros.set({})
    this.erroGeral.set(null)

    try {
      const r = ed.conexaoId
        ? await this.servico.alterar(ed.conexaoId, { credencial: this.credencial() })
        : await this.servico.criar({
            conector: ed.conector, nomeAmigavel: ed.nome, credencial: this.credencial(),
          })

      if (!r.ok) {
        // ⚠️ Erro por CAMPO vai para o campo. Só o que não tem campo vira
        //    mensagem geral — erro geral obriga a conferir tudo de novo.
        this.erros.set(r.erro.detalhe?.campos ?? (r.erro.detalhe?.campo ? { [r.erro.detalhe.campo]: r.erro.mensagem } : {}))
        if (!r.erro.detalhe?.campos && !r.erro.detalhe?.campo) {
          this.erroGeral.set(
            r.erro.detalhe?.comoResolver ? `${r.erro.mensagem} ${r.erro.detalhe.comoResolver}` : r.erro.mensagem,
          )
        }
        return
      }

      const id = ed.conexaoId ?? ('id' in r ? r.id : undefined)
      if (!id) return
      this.editando.set(null)
      this.limpar()
      // Salvar e testar é um gesto só: salvar sem testar deixa a pessoa achando
      // que terminou, e o problema aparece na primeira carga, sem ninguém olhando.
      await this.testar({ id } as Conexao)
    } finally {
      this.salvando.set(false)
    }
  }

  async testar(c: Conexao): Promise<void> {
    const r = await this.servico.testar(c.id)
    this.resultado.update((atual) => ({ ...atual, [c.id]: r }))
  }
}
