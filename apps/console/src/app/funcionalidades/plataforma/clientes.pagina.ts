import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { AuthServico } from '../../nucleo/auth.servico.js'
import { FormsModule } from '@angular/forms'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EsqueletoComponente,
  EstadoComponente, GradeFormComponente, IconeComponente, ModalComponente, SecaoFormComponente, SelectComponente,
  SelectPaginadoComponente, TabelaComponente, ToastServico, mensagemDeErro, type CarregarOpcoes, type ColunaTabela,
  type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { ModelosClienteComponente } from './modelos-cliente.componente.js'

interface Cliente {
  readonly id: string
  readonly nome: string
  readonly fuso: string
  readonly ativo: boolean
  readonly criadoEm: string
  readonly plano: string
}
interface ModeloFunil {
  readonly codigo: string
  readonly nome: string
  readonly descricao: string
  readonly etapas: readonly { readonly nome: string; readonly tipo: string }[]
}
interface Opcoes {
  readonly planos: readonly { readonly codigo: string; readonly nome: string }[]
  readonly verticais: readonly { readonly codigo: string; readonly nome: string }[]
  readonly modelosFunil: readonly ModeloFunil[]
  readonly podeCriarLogin: boolean
}
interface Criado {
  readonly id: string
  readonly nome: string
  readonly login: { criado: boolean; email?: string; senha?: string; erro?: string }
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Cadastro de clientes (staff do drezz). Cria a empresa já com o funil montado
 * no modelo do negócio dela, e opcionalmente o primeiro login.
 *
 * ⚠️ A senha inicial aparece UMA vez, no retorno da criação — como o segredo do
 * webhook. Não há como buscá-la depois; se perder, o caminho é redefinir.
 *
 * Padrão Lista com modal: empresas em ui-tabela; cadastro em modal M; entrada
 * com motivo em modal A; "Nomear admin" com select paginado (X4).
 */
@Component({
  selector: 'app-clientes-plataforma',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, DatePipe, EsqueletoComponente, EstadoComponente,
    FormsModule, GradeFormComponente, IconeComponente, ModelosClienteComponente, ModalComponente, SecaoFormComponente,
    SelectComponente, SelectPaginadoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Clientes" subtitulo="As empresas que usam o sistema. Cadastrar aqui já monta o funil e o acesso.">
      <button type="button" class="btn btn--primario" (click)="abrirNova()"><ui-icone nome="plus" />Nova empresa</button>
    </ui-cabecalho-tela>

    <div class="corpo">
      @if (opcoes(); as o) {
        @if (!o.podeCriarLogin) {
          <p class="aviso-login" role="status">
            <ui-icone nome="alert-triangle" />
            <span>Esta API não está configurada para criar logins — dá para cadastrar a empresa,
            mas o acesso terá de ser criado à parte.</span>
          </p>
        }
      }

      @if (criado(); as c) {
        <section class="painel novo" role="status">
          <h2 class="txt-secao">{{ c.nome }} foi criada</h2>
          @if (c.login.criado) {
            <p class="novo-dica"><ui-icone nome="alert-triangle" /> Anote a senha agora — ela não aparece de novo.</p>
            <dl class="credenciais">
              <div><dt>Acesso</dt><dd class="txt-dados">{{ c.login.email }}</dd></div>
              <div><dt>Senha inicial</dt><dd class="txt-dados senha">{{ c.login.senha }}</dd></div>
            </dl>
          } @else if (c.login.erro) {
            <p class="novo-erro">A empresa foi criada, mas o login não: {{ c.login.erro }}</p>
          } @else {
            <p class="novo-dica">Sem login por enquanto — cadastre o acesso quando quiser.</p>
          }
          <button type="button" class="btn btn--secundario" (click)="criado.set(null)">Fechar</button>
        </section>
      }

      @switch (estado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true">
            <ui-esqueleto altura="18px" />
            <ui-esqueleto altura="18px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Esta área é do staff" descricao="Seu usuário não está no grupo que administra clientes." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as empresas" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (itens().length === 0) {
            <ui-estado titulo="Nenhuma empresa ainda" descricao="A primeira empresa cadastrada aparece aqui.">
              <button type="button" class="btn btn--secundario" (click)="abrirNova()">Nova empresa</button>
            </ui-estado>
          } @else {
            <ui-tabela [colunas]="colunas" [linhas]="linhas()" [rotuloLinha]="rotuloLinha">
              <ng-template uiCelula="nome" let-c>
                <span class="c-nome">{{ c.nome }}</span>
              </ng-template>
              <ng-template uiCelula="estado" let-c>
                <ui-badge [tom]="c.ativo ? 'sucesso' : 'neutro'">{{ c.ativo ? 'Ativa' : 'Inativa' }}</ui-badge>
              </ng-template>
              <ng-template uiCelula="criadoEm" let-c>{{ c.criadoEm | date: 'dd/MM/yyyy' }}</ng-template>
              <ng-template uiCelula="acoes" let-c>
                <span class="acoes">
                  <button type="button" class="btn btn--fantasma btn--pequeno" (click)="alternarModelos(c)"
                    [attr.aria-expanded]="modelosAberto() === c.id">
                    {{ modelosAberto() === c.id ? 'Fechar modelos' : 'Modelos de IA' }}
                  </button>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirNomear(c)">Nomear admin</button>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="pedirMotivo(c)"
                    [disabled]="entrando() === c.id">
                    {{ entrando() === c.id ? 'Entrando…' : 'Entrar' }}
                  </button>
                </span>
              </ng-template>
            </ui-tabela>

            @if (clienteModelos(); as c) {
              <section class="painel expansao" [attr.aria-label]="'Modelos de IA de ' + c.nome">
                <app-modelos-cliente [clienteId]="c.id" [clienteNome]="c.nome" (fechar)="modelosAberto.set(null)" />
              </section>
            }
          }
        }
      }
    </div>

    <!-- Cadastro de empresa (M): campos com rótulo visível; erro no campo, não em toast. -->
    <ui-modal [aberto]="novaAberta()" titulo="Nova empresa" largura="g" [sujo]="false" (fechar)="fecharNova()">
      <form id="form-nova-empresa" (submit)="cadastrar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Nome da empresa" placeholder="Confecção Exemplo Ltda" [obrigatorio]="true"
            [(valor)]="nome" [erro]="erroNome()" />
          <ui-select rotulo="Plano" placeholder="Escolha o plano" [opcoes]="opcoesPlanos()" [obrigatorio]="true"
            [(valor)]="plano" [erro]="erroPlano()" />
          <ui-select rotulo="Perfil de vertical" placeholder="Escolha o perfil" [opcoes]="opcoesVerticais()" [obrigatorio]="true"
            [(valor)]="vertical" [erro]="erroVertical()" />
          <ui-select class="largo" rotulo="Modelo de funil" [opcoes]="opcoesModelos()" [(valor)]="modelo" />
        </ui-grade-form>

        @if (modeloEscolhido(); as m) {
          <p class="preview-dica">{{ m.descricao }}</p>
          <div class="preview" aria-label="Etapas do funil">
            @for (e of m.etapas; track e.nome) {
              <span class="raia" [class]="'raia--' + e.tipo">{{ e.nome }}</span>
            }
          </div>
        }

        <ui-secao-form titulo="Primeiro acesso (opcional)">
          <ui-grade-form>
            <ui-campo rotulo="Nome de quem vai acessar" placeholder="Maria Silva" [(valor)]="adminNome" />
            <ui-campo rotulo="E-mail" tipo="email" placeholder="maria@confeccao.com.br" [(valor)]="adminEmail"
              dica="O e-mail fica preso à empresa para sempre: o vínculo não pode ser alterado depois." />
          </ui-grade-form>
        </ui-secao-form>

        @if (erroForm(); as e) { <p class="erro-add" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharNova()">Cancelar</button>
        <button type="submit" form="form-nova-empresa" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Cadastrando…' : 'Cadastrar empresa' }}
        </button>
      </div>
    </ui-modal>

    <!-- Entrada com motivo (A): o motivo vai para a trilha do cliente. -->
    <ui-modal [aberto]="entrada() !== null" [titulo]="'Entrar em ' + (entrada()?.nome ?? '')" largura="p" (fechar)="cancelarMotivo()">
      <form id="form-entrar-cliente" (submit)="confirmarEntrada($event)">
        <p class="nomear-texto">Você vai entrar nesta empresa como staff. O motivo fica registrado na trilha do cliente.</p>
        <ui-campo rotulo="Motivo do acesso" placeholder="Ex.: suporte a pedido do cliente" [obrigatorio]="true"
          dica="Sem motivo, o acesso não é aberto." [(valor)]="motivo" [erro]="erroEntrar()" />
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="cancelarMotivo()">Cancelar</button>
        <button type="submit" form="form-entrar-cliente" class="btn btn--primario" [disabled]="entrando() !== null">
          {{ entrando() !== null ? 'Entrando…' : 'Entrar' }}
        </button>
      </div>
    </ui-modal>

    <ui-modal [aberto]="nomeando() !== null" titulo="Nomear administrador" largura="p" (fechar)="fecharNomear()">
      <form id="form-nomear-admin" (submit)="nomearAdmin($event)">
        <p class="nomear-texto">
          O usuário vira admin de <strong>{{ nomeando()?.nome }}</strong> em todas as filiais. Use quando a empresa
          ainda não tem administrador: depois disso, ele cadastra os próprios usuários e filiais.
        </p>
        <ui-select-paginado rotulo="Usuário" placeholder="Busque por nome ou e-mail" [obrigatorio]="true" [largo]="true"
          [carregar]="carregarUsuarios" [erro]="erroNomear()" name="usuarioAdmin"
          [ngModel]="usuarioAdmin()" (ngModelChange)="usuarioAdmin.set($event ?? '')"
          dica="Só aparecem usuários da empresa que já entraram no sistema ou foram cadastrados." />
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharNomear()">Cancelar</button>
        <button type="submit" form="form-nomear-admin" class="btn btn--primario" [disabled]="nomeandoSalvando()">
          {{ nomeandoSalvando() ? 'Nomeando…' : 'Nomear' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .esqueletos { display: grid; gap: var(--espacamento-2); padding: var(--espacamento-4); }
    .nomear-texto { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .aviso-login { display: flex; align-items: flex-start; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--atencao); font-size: 13px; }
    .novo { border-color: var(--sucesso); }
    .novo-dica { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .novo-erro { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .credenciais { display: flex; flex-wrap: wrap; gap: var(--espacamento-5); margin: 0 0 var(--espacamento-4); }
    .credenciais dt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--texto-suave); }
    .credenciais dd { margin: 2px 0 0; color: var(--texto); font-size: 14px; }
    .senha { padding: 2px 8px; border-radius: var(--raio-controle); background: var(--fundo); user-select: all; }
    .preview-dica { margin: var(--espacamento-3) 0 var(--espacamento-2); color: var(--texto-secundario); font-size: 12px; }
    .preview { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .raia { font-size: 12px; padding: 2px 10px; border-radius: var(--raio-completo);
      border: 1px solid var(--borda); color: var(--texto-secundario); background: var(--superficie); }
    .raia--ganho { border-color: transparent; background: var(--sucesso-suave); color: var(--sucesso); }
    .raia--perdido { border-color: transparent; background: var(--erro-suave); color: var(--erro); }
    .erro-add { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .c-nome { color: var(--texto); font-size: 14px; font-weight: 500; }
    .acoes { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--espacamento-1); }
    .expansao { margin-top: var(--espacamento-2); }
  `,
})
export class ClientesPlataformaPagina implements OnInit {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Cliente[]>([])
  readonly linhas = computed(() => this.itens() as unknown as LinhaTabela[])
  readonly opcoes = signal<Opcoes | null>(null)
  readonly criado = signal<Criado | null>(null)
  readonly salvando = signal(false)
  readonly erroForm = signal<string | null>(null)
  readonly entrando = signal<string | null>(null)
  readonly pedindoMotivo = signal<string | null>(null)
  readonly motivo = signal('')
  readonly erroEntrar = signal<string | null>(null)
  /** Um painel de modelos aberto por vez — o id do cliente expandido. */
  readonly modelosAberto = signal<string | null>(null)
  private readonly auth = inject(AuthServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  /** Cliente cujo modal "Nomear admin" está aberto. */
  readonly nomeando = signal<Cliente | null>(null)
  readonly usuarioAdmin = signal('')
  readonly erroNomear = signal<string | null>(null)
  readonly nomeandoSalvando = signal(false)

  readonly novaAberta = signal(false)
  readonly nome = signal('')
  readonly plano = signal('')
  readonly vertical = signal('')
  readonly modelo = signal('crm-recompra')
  readonly adminNome = signal('')
  readonly adminEmail = signal('')
  readonly erroNome = signal<string | null>(null)
  readonly erroPlano = signal<string | null>(null)
  readonly erroVertical = signal<string | null>(null)

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Empresa' },
    { chave: 'plano', rotulo: 'Plano', mono: true, largura: '120px' },
    { chave: 'criadoEm', rotulo: 'Criada em', mono: true, largura: '120px' },
    { chave: 'estado', rotulo: 'Estado', largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '340px' },
  ]
  protected readonly rotuloLinha = (l: LinhaTabela): string => String(l['nome'] ?? 'empresa')

  /** Opções dos selects do cadastro: o `OpcaoSelect` é o que `ui-select` recebe. */
  protected readonly opcoesPlanos = computed<OpcaoSelect[]>(() =>
    (this.opcoes()?.planos ?? []).map((p) => ({ valor: p.codigo, rotulo: p.nome })))
  protected readonly opcoesVerticais = computed<OpcaoSelect[]>(() =>
    (this.opcoes()?.verticais ?? []).map((v) => ({ valor: v.codigo, rotulo: v.nome })))
  protected readonly opcoesModelos = computed<OpcaoSelect[]>(() =>
    (this.opcoes()?.modelosFunil ?? []).map((m) => ({ valor: m.codigo, rotulo: m.nome })))

  /** Cliente cujo painel de modelos de IA está aberto. */
  protected readonly clienteModelos = computed(() => this.itens().find((c) => c.id === this.modelosAberto()) ?? null)
  /** Cliente da entrada com motivo (modal A). */
  protected readonly entrada = computed(() => this.itens().find((c) => c.id === this.pedindoMotivo()) ?? null)

  ngOnInit(): void { void this.carregar() }

  modeloEscolhido(): ModeloFunil | undefined {
    return this.opcoes()?.modelosFunil.find((m) => m.codigo === this.modelo())
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [lista, ops] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Cliente[] }>('/v1/plataforma/clientes')),
        firstValueFrom(this.http.get<Opcoes>('/v1/plataforma/opcoes')),
      ])
      this.itens.set(lista.itens)
      this.opcoes.set(ops)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && (e.status === 403 || e.status === 401) ? 'sem_permissao' : 'erro')
    }
  }

  abrirNova(): void {
    this.erroForm.set(null)
    this.erroNome.set(null); this.erroPlano.set(null); this.erroVertical.set(null)
    this.novaAberta.set(true)
  }

  /** Fechar com dados digitados pede confirmação; sem nada digitado, fecha direto. */
  async fecharNova(): Promise<void> {
    if (this.salvando()) return
    const digitado = [this.nome(), this.adminNome(), this.adminEmail(), this.plano(), this.vertical()].some((v) => v.trim() !== '')
    if (digitado && !(await this.confirmacao.confirmar({
      titulo: 'Descartar o cadastro?', mensagem: 'Os dados digitados da empresa ainda não foram salvos.',
      acao: 'Descartar', cancelar: 'Continuar editando', perigo: true,
    }))) return
    this.novaAberta.set(false)
  }

  pedirMotivo(c: Cliente): void {
    this.motivo.set('')
    this.erroEntrar.set(null)
    this.pedindoMotivo.set(c.id)
  }

  alternarModelos(c: Cliente): void {
    this.modelosAberto.update((atual) => (atual === c.id ? null : c.id))
  }

  cancelarMotivo(): void {
    if (this.entrando() !== null) return
    this.pedindoMotivo.set(null)
    this.motivo.set('')
    this.erroEntrar.set(null)
  }

  /** Usuários do cliente do modal, por cursor, com busca no servidor (rota de staff). */
  protected readonly carregarUsuarios: CarregarOpcoes = async (cursor, termo) => {
    const c = this.nomeando()
    if (!c) return { itens: [], proximoCursor: null }
    const q = new URLSearchParams()
    if (cursor) q.set('cursor', cursor)
    if (termo.trim()) q.set('busca', termo.trim())
    const r = await firstValueFrom(this.http.get<{
      itens: { id: string; nome: string; email: string; ativo: boolean; papeis: string[] }[]; proximoCursor: string | null
    }>(`/v1/plataforma/clientes/${c.id}/usuarios${q.size ? `?${q}` : ''}`))
    return {
      itens: r.itens.map((u) => ({ valor: u.id, rotulo: u.nome, dica: u.ativo ? u.email : `${u.email} (inativo)` })),
      proximoCursor: r.proximoCursor,
    }
  }

  abrirNomear(c: Cliente): void {
    this.usuarioAdmin.set('')
    this.erroNomear.set(null)
    this.nomeando.set(c)
  }

  fecharNomear(): void {
    if (!this.nomeandoSalvando()) this.nomeando.set(null)
  }

  /** Nomeia admin atribuído do cliente (staff). A API valida o usuário; aqui só o campo vazio. */
  async nomearAdmin(ev: Event): Promise<void> {
    ev.preventDefault()
    const c = this.nomeando()
    if (!c || this.nomeandoSalvando()) return
    const usuarioId = this.usuarioAdmin().trim()
    if (!usuarioId) {
      this.erroNomear.set('Escolha o usuário.')
      return
    }
    this.nomeandoSalvando.set(true)
    this.erroNomear.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/plataforma/clientes/' + c.id + '/admin', { usuarioId }))
      this.nomeando.set(null)
      this.toast.sucesso(c.nome + ': administrador nomeado.')
    } catch (e) {
      this.erroNomear.set(mensagemDeErro(e, 'Não foi possível nomear o administrador.'))
    } finally {
      this.nomeandoSalvando.set(false)
    }
  }

  confirmarEntrada(ev: Event): void {
    ev.preventDefault()
    const c = this.entrada()
    if (c) void this.entrar(c)
  }

  /**
   * Abre uma sessão de acesso e entra no cliente (PLT-05).
   *
   * ⚠️ O motivo é pedido antes e vai para a trilha do CLIENTE — acesso a dado de
   * cliente sem justificativa registrada é o que uma auditoria externa cobra.
   * Erro fica no modal (o motivo digitado não se perde).
   */
  async entrar(c: Cliente): Promise<void> {
    const motivo = this.motivo().trim()
    if (!motivo) {
      this.erroEntrar.set('Informe o motivo do acesso.')
      return
    }
    this.entrando.set(c.id)
    this.erroEntrar.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ token: string }>('/v1/staff/acessos',
        { tenantId: c.id, motivo }))
      this.auth.entrarNoCliente(r.token, c.nome) // recarrega a aplicação
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string }) : null
      this.erroEntrar.set(corpo?.mensagem ?? 'Não foi possível entrar neste cliente.')
      this.entrando.set(null)
    }
  }

  async cadastrar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.erroNome.set(this.nome().trim() ? null : 'Informe o nome da empresa.')
    this.erroPlano.set(this.plano() ? null : 'Escolha o plano.')
    this.erroVertical.set(this.vertical() ? null : 'Escolha o perfil de vertical.')
    if (this.erroNome() || this.erroPlano() || this.erroVertical()) return
    this.salvando.set(true)
    this.erroForm.set(null)
    try {
      const email = this.adminEmail().trim()
      const r = await firstValueFrom(this.http.post<Criado>('/v1/plataforma/clientes', {
        nome: this.nome().trim(),
        planoCodigo: this.plano(),
        verticalCodigo: this.vertical(),
        modeloFunil: this.modelo(),
        ...(email ? { admin: { nome: this.adminNome().trim(), email } } : {}),
      }))
      this.criado.set(r)
      this.nome.set(''); this.adminNome.set(''); this.adminEmail.set('')
      this.novaAberta.set(false)
      await this.carregar()
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string }) : null
      this.erroForm.set(corpo?.mensagem ?? 'Não foi possível cadastrar a empresa.')
    } finally {
      this.salvando.set(false)
    }
  }
}
