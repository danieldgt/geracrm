import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ConexoesServico } from './conexoes.servico.js'
import { FormularioCredencialComponente } from './formulario-credencial.componente.js'
import { CAPACIDADES, MENSAGEM_FALHA, type Conexao, type ResultadoTeste } from './tipos.js'
import { PERFIS_PRECO } from '@geracrm/shared'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, IconeComponente,
  ModalComponente, SelectComponente, TabelaComponente, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'

interface TabelaPreco {
  readonly idExterno: string; readonly descricao: string
  readonly padrao: boolean; readonly perfil: string | null; readonly skus: number
}

/**
 * Configurações → ERP. Lista das conexões em ui-tabela (uma linha por ERP), tabelas de
 * preço por perfil, sincronizações recentes, e o cadastro/credenciais em ui-modal.
 *
 * ⚠️ A tela nunca nomeia fornecedor por conta própria: mostra `nomeAmigavel`.
 * Um cliente de outro ERP lendo "GeraCloud" na própria tela é bug visível (A-07).
 */
@Component({
  selector: 'app-conexoes-erp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, DatePipe, EstadoComponente, FormularioCredencialComponente,
    IconeComponente, ModalComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Integração com o ERP"
      subtitulo="É daqui que vêm seus clientes, produtos e vendas. Sem ele, o CRM começa vazio.">
      @if (servico.estado() === 'pronto' && !servico.vazio()) {
        <button type="button" class="btn btn--primario" (click)="abrirNovo()"><ui-icone nome="plus" />Conectar outro ERP</button>
      }
    </ui-cabecalho-tela>

    <div class="corpo">
      <!-- ⚠️ Os cinco estados são ramos explícitos, não derivados do tamanho da
           lista: vazio-por-falha e vazio-por-não-ter pedem telas opostas. -->
      @switch (servico.estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <!-- Sem "tentar de novo": tentar de novo não vai funcionar nunca. -->
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso às integrações"
            descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as integrações" [descricao]="servico.erro() ?? ''">
            <button type="button" class="btn btn--secundario" (click)="servico.carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (servico.vazio()) {
            <ui-estado titulo="Nenhum ERP conectado"
              descricao="Conecte seu ERP para trazer a base de clientes e o histórico de compras. É o que faz a recompra e o RFV funcionarem desde o primeiro dia.">
              <button type="button" class="btn btn--secundario" (click)="abrirNovo()">Conectar meu ERP</button>
            </ui-estado>
          } @else {
            <ui-tabela [colunas]="colunas" [linhas]="linhas()">
              <ng-template uiCelula="conexao" let-conexao>
                <strong class="nome">{{ conexao.nomeAmigavel }}</strong>
                <!-- Nunca o código do conector. ⚠️ A identificação remota é o único jeito de notar que conectou na loja errada. -->
                @if (conexao.identificacaoRemota; as remota) {
                  <span class="remota">Conectado em: <strong>{{ remota }}</strong></span>
                }
              </ng-template>

              <ng-template uiCelula="situacao" let-conexao>
                <ui-badge [tom]="tomEstado(conexao)">{{ rotuloEstado(conexao) }}</ui-badge>
                @if (conexao.estado === 'com_erro' && conexao.ultimoErroMotivo; as motivo) {
                  <div class="falha" role="status">
                    <strong>{{ mensagem(motivo).titulo }}</strong>
                    <p>{{ mensagem(motivo).acao }}</p>
                    @if (conexao.ultimoErro) { <p class="detalhe">{{ conexao.ultimoErro }}</p> }
                  </div>
                }
                @if (resultado()[conexao.id]; as r) {
                  <p class="resultado" [class.resultado--ok]="r.ok" role="status">
                    @if (r.ok) {
                      <ui-icone nome="check" [tamanho]="14" />Conexão funcionando{{ r.identificacao ? ' — ' + r.identificacao : '' }}.
                    } @else {
                      <ui-icone nome="alert-triangle" [tamanho]="14" />{{ mensagem(r.motivo).titulo }}. {{ mensagem(r.motivo).acao }}
                    }
                  </p>
                }
              </ng-template>

              <ng-template uiCelula="validacao" let-conexao>
                <span class="data">Validada: {{ conexao.ultimaValidacaoEm ? (conexao.ultimaValidacaoEm | date: 'short') : 'nunca' }}</span>
                <!-- ⚠️ A distância entre as duas datas é o sinal: validação velha com tentativa recente = está tentando e falhando. -->
                @if (tentandoEFalhando(conexao)) {
                  <span class="data alerta">Última tentativa: {{ conexao.ultimaTentativaEm | date: 'short' }}</span>
                }
              </ng-template>

              <ng-template uiCelula="recursos" let-conexao>
                <!-- ⚠️ Degradação VISÍVEL (ADR-008): a tela diz o que o produto deixa de fazer, com a consequência. -->
                @if (faltantes(conexao).length > 0) {
                  <details class="degradacao">
                    <summary>{{ faltantes(conexao).length }} recurso(s) que este ERP não oferece</summary>
                    <ul>
                      @for (c of faltantes(conexao); track c.chave) {
                        <li><strong>{{ c.rotulo }}:</strong> {{ c.ausente }}</li>
                      }
                    </ul>
                  </details>
                } @else {
                  <span class="suave">Todos os recursos</span>
                }
              </ng-template>

              <ng-template uiCelula="acoes" let-conexao>
                <span class="acoes">
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="testar(conexao)" [disabled]="servico.testando().has(conexao.id)">
                    {{ servico.testando().has(conexao.id) ? 'Testando…' : 'Testar conexão' }}
                  </button>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirCredencial(conexao)">
                    {{ conexao.credencial.configurada ? 'Trocar credenciais' : 'Preencher credenciais' }}
                  </button>
                </span>
              </ng-template>

              <div uiVazio>
                <ui-estado titulo="Nenhum ERP conectado" descricao="Conecte seu ERP para começar.">
                  <button type="button" class="btn btn--secundario" (click)="abrirNovo()">Conectar meu ERP</button>
                </ui-estado>
              </div>
            </ui-tabela>
          }
        }
      }

      <!-- INT-08: o que cada sincronização trouxe e rejeitou. Estado PARCIAL da tela — some sozinho se a carga nunca rodou. -->
      @if (servico.operacoes().length) {
        <!-- ⚠️ Qual tabela pratica varejo e qual pratica atacado. Sem declarar, o produto adivinha pelo NOME da tabela. -->
        @if (tabelas().length > 0) {
          <section class="bloco-secao" aria-labelledby="tp-titulo">
            <h2 id="tp-titulo" class="txt-secao">Tabelas de preço</h2>
            <p class="dica">Diga qual tabela do ERP vale para cada perfil. Sem isso, o catálogo tenta adivinhar pelo nome — e erra quando o nome não diz.</p>
            <div class="tp-linhas">
              @for (perfil of PERFIS; track perfil) {
                <ui-select [rotulo]="perfil === 'varejo' ? 'Varejo' : 'Atacado'" placeholder="— adivinhar pelo nome —"
                  [opcoes]="opcoesTabela()" [valor]="escolha()[perfil] ?? ''" (valorChange)="escolher(perfil, $event)" />
              }
            </div>
            <div class="acoes-linha">
              <button type="button" class="btn btn--primario btn--pequeno" (click)="salvarPerfis()" [disabled]="salvandoPerfis()">
                {{ salvandoPerfis() ? 'Salvando…' : 'Salvar tabelas' }}
              </button>
              @if (msgPerfis()) {
                <span [class]="erroPerfis() ? 'tp-err' : 'tp-ok'" role="status">{{ msgPerfis() }}</span>
              }
            </div>
          </section>
        }

        <section class="bloco-secao" aria-labelledby="sync-titulo">
          <h2 id="sync-titulo" class="txt-secao">Últimas sincronizações</h2>
          <ui-tabela [colunas]="colunasOperacao" [linhas]="linhasOperacao()" [chaveLinha]="chaveOperacao">
            <ng-template uiCelula="fluxo" let-op>{{ rotuloFluxo(op.fluxo) }}</ng-template>
            <!-- Rejeição é sinal de conciliação, não erro fatal: destaca só quando há. -->
            <ng-template uiCelula="rejeitados" let-op>
              <span class="num" [class.num--alerta]="op.rejeitados > 0">{{ op.rejeitados }}</span>
            </ng-template>
            <ng-template uiCelula="quando" let-op>{{ (op.concluidoEm ?? op.iniciadoEm) | date: 'dd/MM HH:mm' }}</ng-template>
          </ui-tabela>
        </section>
      }
    </div>

    <!-- Cadastro e credenciais: modal de cadastro (M). Esc, véu e × passam por fechar(). -->
    <ui-modal [aberto]="editando() !== null" [titulo]="tituloEdicao()" largura="p" (fechar)="fechar()">
      @if (editando(); as ed) {
        @if (!ed.conexaoId) {
          <ui-select rotulo="Qual é o seu ERP?" [opcoes]="opcoesConectores()" [valor]="ed.conector"
            (valorChange)="trocarConector($event)" [dica]="conectorAtual()?.descricao ?? ''" />

          <!-- ⚠️ Este nome aparece em toda mensagem de erro do produto. -->
          <ui-campo rotulo="Como chamar esta conexão" placeholder="ERP da matriz"
            dica="Aparece nas mensagens do sistema — &quot;o ERP da matriz não respondeu&quot;."
            [valor]="ed.nome" (valorChange)="nomeMudou($event)" [erro]="erros()['nomeAmigavel'] ?? null" />
        }

        @if (conectorAtual(); as conector) {
          <app-formulario-credencial
            [esquema]="conector.esquemaCredencial"
            [erros]="erros()"
            (mudou)="credencialMudou($event)"
          />
        }

        @if (erroGeral(); as msg) { <p class="erro-geral" role="alert">{{ msg }}</p> }
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="button" class="btn btn--primario" (click)="salvar()" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Salvar e testar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-6); min-width: 0; }
    .nome { display: block; color: var(--texto); }
    .remota { display: block; margin-top: 2px; font-size: 12px; color: var(--texto-secundario); }
    .suave { color: var(--texto-suave); font-size: 13px; }
    .data { display: block; font-size: 12px; color: var(--texto-secundario); font-family: var(--tipografia-familia-dados); }
    .data.alerta { color: var(--atencao); }
    .falha { margin-top: var(--espacamento-2); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--superficie); border-left: 3px solid var(--erro); max-width: 46ch; }
    .falha strong { color: var(--texto); font-size: 13px; }
    .falha p { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 12px; }
    .detalhe { font-family: var(--tipografia-familia-dados); color: var(--texto-suave) !important; overflow-wrap: anywhere; }
    .degradacao { font-size: 13px; }
    .degradacao summary { cursor: pointer; color: var(--texto-secundario); }
    .degradacao ul { margin: var(--espacamento-2) 0 0; padding-left: var(--espacamento-4); color: var(--texto-secundario); line-height: 1.6; }
    .acoes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--espacamento-2); }
    .resultado { display: flex; align-items: center; gap: var(--espacamento-1); margin: var(--espacamento-2) 0 0; font-size: 13px; color: var(--erro); }
    .resultado--ok { color: var(--sucesso); }
    .bloco-secao { display: grid; gap: var(--espacamento-3); }
    .dica { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .tp-linhas { display: grid; gap: var(--espacamento-3); max-width: 560px; }
    .acoes-linha { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .tp-ok { color: var(--sucesso); font-size: 13px; }
    .tp-err { color: var(--erro); font-size: 13px; }
    .num { font-family: var(--tipografia-familia-dados); }
    .num--alerta { color: var(--atencao); }
    .erro-geral { margin: 0; color: var(--erro); font-size: 13px; }
  `,
})
export class ConexoesPagina implements OnInit {
  readonly servico = inject(ConexoesServico)
  private readonly http = inject(HttpClient)
  readonly PERFIS = PERFIS_PRECO
  readonly tabelas = signal<readonly TabelaPreco[]>([])
  readonly escolha = signal<Record<string, string>>({})
  readonly salvandoPerfis = signal(false)
  readonly msgPerfis = signal<string | null>(null)
  readonly erroPerfis = signal(false)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'conexao', rotulo: 'ERP' },
    { chave: 'situacao', rotulo: 'Situação' },
    { chave: 'validacao', rotulo: 'Validação', largura: '200px' },
    { chave: 'recursos', rotulo: 'Recursos', largura: '260px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '240px' },
  ]
  protected readonly colunasOperacao: ColunaTabela[] = [
    { chave: 'fluxo', rotulo: 'Fluxo' },
    { chave: 'total', rotulo: 'Lidos', alinhamento: 'dir', mono: true, largura: '100px' },
    { chave: 'aceitos', rotulo: 'Aceitos', alinhamento: 'dir', mono: true, largura: '100px' },
    { chave: 'rejeitados', rotulo: 'Rejeitados', alinhamento: 'dir', largura: '120px' },
    { chave: 'quando', rotulo: 'Quando', mono: true, largura: '130px' },
  ]
  protected readonly linhas = computed(() => this.servico.conexoes() as unknown as readonly LinhaTabela[])
  protected readonly linhasOperacao = computed(() => this.servico.operacoes() as unknown as readonly LinhaTabela[])
  protected readonly chaveOperacao = (l: LinhaTabela): string => `${String(l['iniciadoEm'])}|${String(l['fluxo'])}`
  protected readonly opcoesTabela = computed<OpcaoSelect[]>(() =>
    this.tabelas().map((t) => ({ valor: t.idExterno, rotulo: `${t.descricao} (${t.skus} ${t.skus === 1 ? 'item' : 'itens'})` })))
  protected readonly opcoesConectores = computed<OpcaoSelect[]>(() =>
    this.servico.conectores().map((c) => ({ valor: c.codigo, rotulo: c.nome })))

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
    void this.carregarTabelas()
  }

  /**
   * As tabelas de preço COTÁVEIS do ERP e o perfil declarado de cada uma.
   *
   * ⚠️ A API já filtra: só venda e ativa. Oferecer uma tabela de CUSTO aqui
   * seria oferecer o erro — cotar a margem da loja a um cliente.
   */
  private async carregarTabelas(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: TabelaPreco[] }>('/v1/integracao/tabelas-preco'))
      this.tabelas.set(r.itens)
      // O que já está declarado vira o estado inicial dos seletores.
      const atual: Record<string, string> = {}
      for (const t of r.itens) if (t.perfil) atual[t.perfil] = t.idExterno
      this.escolha.set(atual)
    } catch { /* sem ERP conectado: a seção não aparece */ }
  }

  escolher(perfil: string, idExterno: string): void {
    this.escolha.update((a) => ({ ...a, [perfil]: idExterno }))
    this.msgPerfis.set(null)
  }

  async salvarPerfis(): Promise<void> {
    if (this.salvandoPerfis()) return
    this.salvandoPerfis.set(true); this.msgPerfis.set(null); this.erroPerfis.set(false)
    try {
      await firstValueFrom(this.http.put('/v1/integracao/tabelas-preco/perfis', {
        varejo: this.escolha()['varejo'] || null,
        atacado: this.escolha()['atacado'] || null,
      }))
      this.msgPerfis.set('Tabelas salvas. O catálogo já usa a partir de agora.')
      await this.carregarTabelas()
    } catch (e) {
      // ⚠️ A API devolve a frase pronta com a ação corretiva — não invente outra.
      this.erroPerfis.set(true)
      this.msgPerfis.set(e instanceof HttpErrorResponse && typeof e.error?.mensagem === 'string'
        ? e.error.mensagem : 'Não foi possível salvar.')
    } finally { this.salvandoPerfis.set(false) }
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

  tomEstado(c: Conexao): 'sucesso' | 'atencao' | 'erro' | 'neutro' {
    switch (c.estado) {
      case 'ativa': return 'sucesso'
      case 'com_erro': return 'erro'
      case 'pausada': return 'atencao'
      default: return 'neutro'
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

  tituloEdicao(): string { return this.editando()?.conexaoId ? 'Trocar credenciais' : 'Conectar ERP' }

  abrirCredencial(c: Conexao): void {
    this.limpar()
    this.editando.set({ conexaoId: c.id, conector: c.conector, nome: c.nomeAmigavel })
  }

  fechar(): void { if (this.salvando()) return; this.editando.set(null); this.limpar() }

  private limpar(): void {
    this.credencial.set({})
    this.erros.set({})
    this.erroGeral.set(null)
  }

  trocarConector(conector: string): void {
    // ⚠️ Troca de ERP limpa a credencial: os campos são outros, e manter o que
    //    foi digitado enviaria um campo que não pertence a este ERP.
    this.credencial.set({})
    this.erros.set({})
    this.editando.update((ed) => (ed ? { ...ed, conector } : ed))
  }

  nomeMudou(nome: string): void {
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
