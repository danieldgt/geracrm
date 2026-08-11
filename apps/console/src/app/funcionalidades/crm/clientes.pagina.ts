import { Component, ChangeDetectionStrategy, inject, OnInit, signal } from '@angular/core'
import { RouterLink, Router } from '@angular/router'
import { FormsModule } from '@angular/forms'
import { ClientesServico, type ClienteRfv } from './clientes.servico.js'

/**
 * Clientes com RFV — a primeira tela que mostra o valor do produto.
 *
 * Princípios (todos de skills/docs do projeto, não improviso):
 *  · 5 estados obrigatórios (especificar-telas) — ramos explícitos, não `length`.
 *  · Densidade > animação (geracrm-console-angular) — 8h na mesma tela.
 *  · Rampa RFV informa antes da leitura, SEMPRE com rótulo (identidade-visual §3).
 *  · Números em monoespaçada, alinhados (identidade-visual).
 *  · Regra de RFV vem de @geracrm/shared — aqui só se apresenta.
 *  · Cor só de design tokens — nada literal.
 */
@Component({
  selector: 'app-clientes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule],
  template: `
    <header class="cabecalho">
      <div>
        <h1>Clientes</h1>
        <p class="sub">Ordenados por quanto já compraram. A cor mostra onde cada um está no ciclo de recompra.</p>
      </div>
      <div class="acoes-topo">
        <button class="secundario" type="button" (click)="mostrarImport.set(!mostrarImport())">
          {{ mostrarImport() ? 'Fechar' : '↑ Importar CSV' }}
        </button>
        <button class="primario" type="button" (click)="mostrarForm.set(!mostrarForm())">
          {{ mostrarForm() ? 'Fechar' : '+ Novo contato' }}
        </button>
      </div>
    </header>

    @if (mostrarImport()) {
      <div class="import">
        <p class="import-ajuda">
          Cole ou envie um CSV com colunas <b>nome</b>, <b>telefone</b> e <b>cnpj/cpf</b>
          (só nome é obrigatório). Separador vírgula ou ponto-e-vírgula.
        </p>
        <input type="file" accept=".csv,text/csv" (change)="arquivoCsv($event)" [disabled]="servico.importando()" />
        <textarea placeholder="nome,telefone,cnpj&#10;Zé,81998617049,11222333000181"
                  [ngModel]="csvTexto()" (ngModelChange)="csvTexto.set($event)" rows="5"
                  [disabled]="servico.importando()"></textarea>
        <div class="import-acoes">
          <button class="primario" type="button" (click)="importar()"
                  [disabled]="servico.importando() || !csvTexto().trim()">
            {{ servico.importando() ? 'Importando…' : 'Importar' }}
          </button>
        </div>
        @if (servico.erroImport(); as e) { <p class="erro-form">{{ e }}</p> }
        @if (servico.resultadoImport(); as r) {
          <div class="import-resultado" role="status">
            <strong>{{ r.criados }} criados</strong> · {{ r.atualizados }} atualizados ·
            <span [class.ruim]="r.rejeitados > 0">{{ r.rejeitados }} rejeitados</span> (de {{ r.total }})
            @if (r.rejeicoes.length) {
              <ul class="rejeicoes">
                @for (rj of r.rejeicoes; track rj.linha) {
                  <li>Linha {{ rj.linha }}: {{ rotuloRejeicao(rj.motivo) }}</li>
                }
              </ul>
            }
          </div>
        }
      </div>
    }

    @if (mostrarForm()) {
      <form class="novo-contato" (ngSubmit)="adicionar(false)">
        <input name="nome" placeholder="Nome" [ngModel]="novoNome()" (ngModelChange)="novoNome.set($event)"
               [disabled]="servico.salvandoContato()" />
        <input name="tel" placeholder="Telefone (DDD + número)" [ngModel]="novoTelefone()"
               (ngModelChange)="novoTelefone.set($event)" [disabled]="servico.salvandoContato()" />
        <button class="primario" type="submit" [disabled]="servico.salvandoContato() || !valido()">
          {{ servico.salvandoContato() ? 'Salvando…' : 'Adicionar' }}
        </button>
        <button class="secundario" type="button" (click)="adicionar(true)"
                [disabled]="servico.salvandoContato() || !valido()">Adicionar e conversar</button>
        @if (servico.erroForm()) { <p class="erro-form">{{ servico.erroForm() }}</p> }
      </form>
    }

    <!-- Busca de contato (acha até contato manual sem venda) -->
    <div class="busca-contato">
      <span class="lupa">🔍</span>
      <input type="search" placeholder="Buscar contato por nome ou telefone"
             [ngModel]="termoBusca()" (ngModelChange)="onBusca($event)" />
      @if (servico.buscando()) { <span class="hint">buscando…</span> }
    </div>
    @if (servico.resultadosBusca().length > 0) {
      <ul class="resultados">
        @for (r of servico.resultadosBusca(); track r.id) {
          <li>
            <a class="nome" [routerLink]="['/contato', r.id]">{{ r.nome }}</a>
            <span class="tel">{{ r.telefone || '—' }}</span>
            <button class="wpp" type="button" title="Conversar no WhatsApp" (click)="conversar(r.id)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="#ffffff" aria-hidden="true"><path fill="#ffffff" d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m5.8 14.03c-.24.68-1.42 1.3-1.95 1.34-.5.05-1.13.24-3.68-.77-3.09-1.22-5.07-4.36-5.22-4.56-.15-.2-1.25-1.66-1.25-3.17s.79-2.25 1.07-2.56c.28-.31.61-.38.81-.38.2 0 .41.01.58.01.19.01.44-.07.69.53.24.6.83 2.07.9 2.22.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.29.76 1.24 1.63 2.01 1.12 1 2.07 1.31 2.36 1.46.29.15.46.12.63-.07.17-.2.73-.85.92-1.14.19-.29.39-.24.65-.15.27.1 1.71.81 2 .96.29.15.49.22.56.34.07.12.07.72-.17 1.4"/></svg>
            </button>
          </li>
        }
      </ul>
    } @else if (termoBusca().trim().length >= 2 && !servico.buscando()) {
      <p class="nada">Nenhum contato encontrado. Use “+ Novo contato” para cadastrar.</p>
    }

    @switch (servico.estado()) {
      @case ('carregando') {
        <!-- Esqueleto com a forma do conteúdo real, nunca spinner solto. -->
        <ul class="lista" aria-busy="true">
          @for (i of [1,2,3,4,5,6,7,8]; track i) { <li class="linha esqueleto"></li> }
        </ul>
      }
      @case ('sem_permissao') {
        <div class="bloco">
          <h2>Você não tem acesso à base de clientes</h2>
          <p>Peça a um administrador da sua empresa para liberar este acesso.</p>
        </div>
      }
      @case ('erro') {
        <div class="bloco">
          <h2>Não foi possível carregar os clientes</h2>
          <p>{{ servico.erro() }}</p>
          <button class="primario" (click)="servico.carregar()">Tentar de novo</button>
        </div>
      }
      @case ('pronto') {
        @if (servico.vazio()) {
          <div class="bloco">
            <h2>Nenhum cliente ainda</h2>
            <p>Conecte seu ERP e faça a primeira carga — os clientes e o histórico de compras aparecem aqui.</p>
          </div>
        } @else {
          <!-- Legenda: a rampa nunca aparece sem explicar o que a cor diz. -->
          <div class="legenda">
            @for (s of legenda; track s.codigo) {
              <span class="chip"><i class="ponto" [style.background]="cor(s.codigo)"></i>{{ s.rotulo }}</span>
            }
          </div>

          <ul class="lista">
            @for (c of servico.clientes(); track c.id) {
              <li class="linha" [style.--acento]="cor(c.segmento.codigo)">
                <span class="segmento" [title]="c.segmento.acao">
                  <i class="ponto" [style.background]="cor(c.segmento.codigo)"></i>
                  {{ c.segmento.rotulo }}
                </span>

                <a class="nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>

                <span class="explica">
                  {{ frase(c) }}
                  @if (!c.confiavel) {
                    <!-- Viaja com o dado: não afirma um ritmo que não dá para ver. -->
                    <em class="estimado" title="Histórico anterior à carga — ritmo estimado">estimado</em>
                  }
                </span>

                <span class="num compras">{{ c.qtdVendas }}<small>compras</small></span>
                <span class="num total">{{ reais(c.totalCentavos) }}</span>
                <span class="acao">{{ c.segmento.acao }}</span>
                <button class="wpp" type="button" title="Conversar no WhatsApp" (click)="conversar(c.id)">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="#ffffff" aria-hidden="true"><path fill="#ffffff" d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m5.8 14.03c-.24.68-1.42 1.3-1.95 1.34-.5.05-1.13.24-3.68-.77-3.09-1.22-5.07-4.36-5.22-4.56-.15-.2-1.25-1.66-1.25-3.17s.79-2.25 1.07-2.56c.28-.31.61-.38.81-.38.2 0 .41.01.58.01.19.01.44-.07.69.53.24.6.83 2.07.9 2.22.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.29.76 1.24 1.63 2.01 1.12 1 2.07 1.31 2.36 1.46.29.15.46.12.63-.07.17-.2.73-.85.92-1.14.19-.29.39-.24.65-.15.27.1 1.71.81 2 .96.29.15.49.22.56.34.07.12.07.72-.17 1.4"/></svg>
                </button>
              </li>
            }
          </ul>

          @if (servico.temMais()) {
            <div class="mais">
              <button (click)="servico.carregarMais()" [disabled]="servico.buscandoMais()">
                {{ servico.buscandoMais() ? 'Carregando…' : 'Carregar mais' }}
              </button>
            </div>
          }
          @if (servico.erro() && !servico.buscandoMais()) {
            <!-- Estado PARCIAL: o que carregou continua utilizável; o aviso é local. -->
            <p class="parcial">Não foi possível carregar mais agora. {{ servico.erro() }}</p>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 1040px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-4); }
    .novo-contato { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-5); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .novo-contato input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .secundario { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); cursor: pointer; }
    .secundario:disabled, .primario:disabled { opacity: .55; cursor: default; }
    .erro-form { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .acoes-topo { display: flex; gap: var(--espacamento-2); }
    .import { display: flex; flex-direction: column; gap: var(--espacamento-2); margin-bottom: var(--espacamento-5); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .import-ajuda { margin: 0; font-size: 13px; color: var(--texto-secundario); }
    .import textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: var(--tipografia-familia-dados, monospace); font-size: 12px; resize: vertical; }
    .import-acoes { display: flex; }
    .import-resultado { font-size: 13px; color: var(--texto-secundario); }
    .import-resultado strong { color: var(--texto); }
    .import-resultado .ruim { color: var(--erro); }
    .rejeicoes { margin: var(--espacamento-2) 0 0; padding-left: var(--espacamento-4); color: var(--texto-suave); font-size: 12px; }
    /* ⚠️ Glifo BRANCO sobre o verde — o padrão do WhatsApp. Verde-escuro sobre
       verde some (vira "bolinha sem ícone"). #hex aqui é a cor de MARCA do
       WhatsApp (não token de design), fora da lib do lint. */
    /* padding:0 e OBRIGATORIO: sem ele o botao herda o padding do estilo base de
       button e, com box-sizing:border-box + width:32px, a area de conteudo fica
       com largura 0; ai o global svg max-width:100% zera o icone. */
    .wpp { border: 0; width: 32px; height: 32px; padding: 0; border-radius: var(--raio-completo); background: #25d366; color: #ffffff; cursor: pointer; display: inline-grid; place-items: center; justify-self: center; }
    .wpp:hover { background: #1ebe5b; }
    /* SVG inline herda baseline e cria um vão de descida — block centra no círculo. */
    .wpp svg { display: block; width: 18px; height: 18px; }
    .busca-contato { position: relative; margin-bottom: var(--espacamento-3); }
    .busca-contato .lupa { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 12px; opacity: .6; }
    .busca-contato input { width: 100%; padding: 10px 12px 10px 34px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .busca-contato .hint { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 12px; color: var(--texto-secundario); }
    .resultados { list-style: none; margin: 0 0 var(--espacamento-5); padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .resultados li { display: grid; grid-template-columns: 1fr auto 40px; align-items: center; gap: var(--espacamento-3); padding: 10px 14px; border-bottom: 1px solid var(--borda); background: var(--superficie-elevada); }
    .resultados li:last-child { border-bottom: 0; }
    .resultados .tel { color: var(--texto-secundario); font-size: 13px; font-variant-numeric: tabular-nums; }
    .nada { margin: 0 0 var(--espacamento-5); color: var(--texto-secundario); font-size: 13px; }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }

    .legenda { display: flex; flex-wrap: wrap; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); padding-bottom: var(--espacamento-3); border-bottom: 1px solid var(--borda); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .ponto { width: 9px; height: 9px; border-radius: var(--raio-completo); display: inline-block; flex: none; }

    .lista { list-style: none; margin: 0; padding: 0; }
    /* ⚠️ Densidade: linha de ~44px, acento lateral da cor do segmento. */
    .linha {
      display: grid;
      grid-template-columns: 150px minmax(120px, 1.4fr) minmax(180px, 2fr) 84px 108px minmax(120px, 1fr) 40px;
      align-items: center; gap: var(--espacamento-3);
      padding: var(--espacamento-2) var(--espacamento-3);
      border-bottom: 1px solid var(--borda);
      border-left: var(--densidade-acento-lateral-card, 3px) solid var(--acento, transparent);
    }
    .linha:hover { background: var(--superficie-hover); }
    .esqueleto { height: 24px; background: var(--superficie); border-left-color: transparent; }
    .segmento { display: inline-flex; align-items: center; gap: var(--espacamento-2); font-size: 12px; font-weight: 500; color: var(--texto); }
    .nome { color: var(--texto); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    .explica { font-size: 12px; color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .estimado { font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); border: 1px solid var(--borda-forte); border-radius: var(--raio-controle); padding: 0 4px; margin-left: 4px; }
    /* ⚠️ Números em monoespaçada, alinhados à direita — o olho compara em coluna. */
    .num { font-family: var(--tipografia-familia-dados); text-align: right; font-variant-numeric: tabular-nums; }
    .compras { font-size: 13px; color: var(--texto-secundario); }
    .compras small { display: block; font-size: 10px; color: var(--texto-suave); }
    .total { font-size: 14px; color: var(--texto); font-weight: 500; }
    .acao { font-size: 12px; color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .mais { text-align: center; padding: var(--espacamento-4); }
    button { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    .primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .parcial { text-align: center; color: var(--atencao); font-size: 13px; }

    @media (max-width: 720px) {
      .linha { grid-template-columns: 1fr auto; row-gap: 2px; }
      .explica, .acao, .compras { display: none; }
    }
  `,
})
export class ClientesPagina implements OnInit {
  readonly servico = inject(ClientesServico)
  private readonly router = inject(Router)

  // Novo contato
  readonly mostrarForm = signal(false)
  readonly novoNome = signal('')
  readonly novoTelefone = signal('')
  valido(): boolean { return this.novoNome().trim().length > 0 && this.novoTelefone().trim().length >= 8 }

  /** Cadastra o contato; se `irConversar`, já abre a conversa no chat. */
  async adicionar(irConversar: boolean): Promise<void> {
    if (!this.valido() || this.servico.salvandoContato()) return
    const id = await this.servico.criarContato(this.novoNome().trim(), this.novoTelefone().trim())
    if (!id) return
    this.novoNome.set(''); this.novoTelefone.set(''); this.mostrarForm.set(false)
    if (irConversar) await this.conversar(id)
  }

  /** "Puxa o contato para o chat": inicia/abre a conversa e navega para o Inbox. */
  async conversar(contatoId: string): Promise<void> {
    const conversaId = await this.servico.iniciarConversa(contatoId)
    if (conversaId) await this.router.navigate(['/conversas'], { queryParams: { abrir: conversaId } })
  }

  // Importação CSV
  readonly mostrarImport = signal(false)
  readonly csvTexto = signal('')
  async arquivoCsv(ev: Event): Promise<void> {
    const arq = (ev.target as HTMLInputElement).files?.[0]
    if (arq) this.csvTexto.set(await arq.text())
  }
  async importar(): Promise<void> {
    const csv = this.csvTexto().trim()
    if (csv) await this.servico.importarCsv(csv)
  }
  rotuloRejeicao(m: string): string {
    switch (m) {
      case 'nome_vazio': return 'nome em branco'
      case 'telefone_invalido': return 'telefone inválido'
      case 'documento_invalido': return 'CNPJ/CPF inválido'
      case 'sem_coluna_nome': return 'faltou a coluna "nome"'
      case 'csv_sem_dados': return 'sem linhas de dados'
      default: return m
    }
  }

  // Busca com debounce (não bate na API a cada tecla).
  readonly termoBusca = signal('')
  private timerBusca?: ReturnType<typeof setTimeout>
  onBusca(v: string): void {
    this.termoBusca.set(v)
    clearTimeout(this.timerBusca)
    this.timerBusca = setTimeout(() => void this.servico.buscarContatos(v), 250)
  }

  // Legenda: só os segmentos que a nossa régua produz, na ordem do ciclo.
  readonly legenda = [
    { codigo: 'cliente-recente', rotulo: 'Novo' },
    { codigo: 'cliente-fiel', rotulo: 'Em dia' },
    { codigo: 'nao-perder', rotulo: 'Na hora' },
    { codigo: 'em-risco', rotulo: 'Atrasado' },
    { codigo: 'semi-perdido', rotulo: 'Sumindo' },
    { codigo: 'hibernando', rotulo: 'Hibernando' },
  ]

  ngOnInit(): void {
    void this.servico.carregar()
  }

  /** A cor vem da rampa RFV dos design tokens — nunca literal. */
  cor(codigo: string): string {
    return `var(--rfv-${codigo})`
  }

  reais(centavos: number): string {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  /**
   * A frase humanizada — o "por quê" explicável (RFV-10). Montada a partir dos
   * números; a régua (o segmento) já veio do domínio.
   */
  frase(c: ClienteRfv): string {
    if (c.diasSemComprar === null) return 'sem data de compra'
    const desde = c.diasSemComprar === 0 ? 'hoje' : `há ${c.diasSemComprar} dias`
    if (c.mediaEntreVendasDias === null || c.qtdVendas < 2) {
      return `comprou ${desde} · 1 compra`
    }
    const ritmo = Math.round(c.mediaEntreVendasDias)
    // Comparado ao ritmo DELE, não a uma média geral.
    if (c.atrasoRelativo !== null && c.atrasoRelativo > 1.3) {
      const alem = Math.round((c.atrasoRelativo - 1) * 100)
      return `comprou ${desde} · costuma a cada ~${ritmo} dias · ${alem}% além do ritmo`
    }
    return `comprou ${desde} · costuma a cada ~${ritmo} dias`
  }
}
