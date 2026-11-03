import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  FiltrosComponente, GradeFormComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ToastServico, codigoDoErro, ehStatus, mensagemDeErro, mesclarPagina,
  type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { digitosDaMascara } from '../../compartilhado/ui/mascaras.js'
import { FiliaisServico } from './filiais.servico.js'
import { UsuariosServico } from './usuarios.servico.js'
import {
  PAPEIS, ROTULO_PAPEL, adicionarLinha, avisaModoFundador, erroDaSenha, erroDoEmail, erroDoNome, indicesDuplicados,
  linhasDosPapeis, mapearErroUsuario, modoFundador, montarPapeis, rotuloDaAtribuicao, temDuplicata, ultimoLoginTexto,
  type CampoUsuario, type LinhaPapel, type UsuarioLista,
} from './usuarios.regras.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
const OPCOES_PAPEL: OpcaoSelect[] = PAPEIS.map((p) => ({ valor: p, rotulo: ROTULO_PAPEL[p] }))
const OPCOES_STATUS: OpcaoSelect[] = [{ valor: 'true', rotulo: 'Ativos' }, { valor: 'false', rotulo: 'Inativos' }]
const MAX_PAGINAS_FILIAIS = 10

/**
 * Usuários (D3.4) — padrão Lista + CRUD em modal. Só admin (403 vira estado "sem permissão").
 * ⚠️ Papel é POR FILIAL. Modo fundador: sem admin ativo, todo ativo vale admin; atribuir o primeiro
 * admin a OUTRA pessoa encerra o modo — o modal avisa para a própria pessoa se tornar admin primeiro.
 */
@Component({
  selector: 'app-usuarios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, FiltrosComponente,
    GradeFormComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Usuários" subtitulo="Quem acessa o sistema, com que papel e em qual filial.">
      <button type="button" class="btn btn--primario" (click)="novo()">+ Novo usuário</button>
    </ui-cabecalho-tela>

    <ui-filtros placeholder="Buscar por nome ou e-mail" rotuloBusca="Busca"
      (buscar)="buscar($event)" (aplicar)="carregar()" (limpar)="limparFiltros()">
      <ui-select rotulo="Situação" placeholder="Todos" [opcoes]="opcoesStatus" [(valor)]="ativo" (valorChange)="carregar()" />
    </ui-filtros>

    <div class="corpo">
      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso a usuários"
            descricao="Só administradores gerenciam usuários. Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os usuários" [descricao]="erroLista()">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @default {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
            <ng-template uiCelula="nome" let-u>
              <span class="duas"><span class="tit">{{ u.nome }}</span><span class="suave">{{ u.email }}</span></span>
            </ng-template>
            <ng-template uiCelula="cargo" let-u>{{ u.cargo || '—' }}</ng-template>
            <ng-template uiCelula="papeis" let-u>
              <span class="papeis">
                @for (p of u.papeis; track p.papel + '|' + p.filialId) {
                  <ui-badge [tom]="p.papel === 'admin' ? 'info' : 'neutro'">{{ rotuloAtribuicao(p) }}</ui-badge>
                } @empty { <span class="suave">Sem papel</span> }
              </span>
            </ng-template>
            <ng-template uiCelula="ativo" let-u>
              <ui-badge [tom]="u.ativo ? 'sucesso' : 'neutro'">{{ u.ativo ? 'Ativo' : 'Inativo' }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="ultimoLoginEm" let-u>{{ ultimoLogin(u.ultimoLoginEm) }}</ng-template>
            <ng-template uiCelula="acoes" let-u>
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="editar(u.id)">Editar</button>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="alternarAtivo(u.id)">
                  {{ u.ativo ? 'Desativar' : 'Ativar' }}
                </button>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirSenha(u.id)">Redefinir senha</button>
              </span>
            </ng-template>
            <div uiVazio>
              @if (temFiltro()) {
                <ui-estado titulo="Nenhum usuário encontrado" descricao="Ajuste a busca ou limpe os filtros.">
                  <button type="button" class="btn btn--secundario" (click)="limparFiltros()">Limpar filtros</button>
                </ui-estado>
              } @else {
                <ui-estado titulo="Nenhum usuário ainda" descricao="Convide a equipe para dar acesso ao sistema.">
                  <button type="button" class="btn btn--primario" (click)="novo()">+ Novo usuário</button>
                </ui-estado>
              }
            </div>
          </ui-tabela>
          @if (estado() === 'pronto') {
            <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null"
              [carregando]="carregandoMais()" (mais)="carregarMais()" />
          }
        }
      }
    </div>

    <ui-modal [aberto]="edicao() !== null" [titulo]="editandoId() ? 'Editar usuário' : 'Novo usuário'" largura="m" (fechar)="fechar()">
      <form id="form-usuario" (submit)="salvar($event)">
        @if (avisoFundador()) {
          <p class="aviso" role="status">
            Esta empresa ainda não tem administrador: hoje todo usuário ativo vale admin. Atribuir admin a OUTRA
            pessoa encerra esse modo e o seu acesso passa a valer só pelo seu próprio papel. Se for você quem
            administra, torne-se admin primeiro.
          </p>
        }
        <ui-grade-form [colunas]="2">
          <ui-campo class="largo" rotulo="Nome" [obrigatorio]="true" [(valor)]="nome" [erro]="erros().nome ?? null" />
          @if (!editandoId()) {
            <ui-campo class="largo" rotulo="E-mail" tipo="email" [obrigatorio]="true" [(valor)]="email" [erro]="erros().email ?? null" />
          } @else {
            <ui-campo class="largo" rotulo="E-mail" [desabilitado]="true" [valor]="email()" dica="O e-mail não pode ser alterado." />
          }
          <ui-campo rotulo="Telefone" mascara="telefone" [(valor)]="telefone" [erro]="erros().telefone ?? null" />
          <ui-campo rotulo="Cargo" [(valor)]="cargo" [erro]="erros().cargo ?? null" />
        </ui-grade-form>

        <fieldset class="papeis-form">
          <legend class="txt-denso">Papéis por filial</legend>
          @for (l of linhasPapel(); track $index) {
            <div class="linha-papel" [class.dup]="duplicadas().includes($index)">
              <ui-select rotulo="Papel" placeholder="Escolha o papel" [opcoes]="opcoesPapel"
                [valor]="l.papel" (valorChange)="atualizarLinha($index, 'papel', $event)" />
              <ui-select rotulo="Filial" placeholder="Todas as filiais" [opcoes]="opcoesFilial()"
                [valor]="l.filialId" (valorChange)="atualizarLinha($index, 'filialId', $event)" />
              <button type="button" class="btn btn--secundario btn--pequeno remover" (click)="removerLinha($index)"
                [attr.aria-label]="'Remover papel ' + ($index + 1)">Remover</button>
            </div>
          } @empty {
            <p class="suave">Sem papel: a pessoa entra, mas não acessa nada. Adicione ao menos um.</p>
          }
          @if (erros().papeis; as e) { <p class="erro-campo" role="alert">{{ e }}</p> }
          @else if (duplicadas().length > 0) { <p class="erro-campo" role="alert">Há papel repetido para a mesma filial.</p> }
          <button type="button" class="btn btn--secundario btn--pequeno" (click)="adicionarPapel()">+ Adicionar papel</button>
        </fieldset>

        @if (!editandoId()) {
          <ui-grade-form [colunas]="2">
            <ui-campo class="largo" rotulo="Senha temporária (opcional)" tipo="password" [(valor)]="senha"
              dica="Sem senha, o convite vai por e-mail." [erro]="erros().senha ?? null" />
          </ui-grade-form>
        }
        @if (erroEnvio(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="submit" form="form-usuario" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>
    </ui-modal>

    <ui-modal [aberto]="senhaDe() !== null" titulo="Redefinir senha" largura="p" (fechar)="fecharSenha()">
      <form id="form-senha" (submit)="salvarSenha($event)">
        <p class="suave">Nova senha temporária para {{ nomeDaSenha() }}. No primeiro login a pessoa será obrigada a trocá-la.</p>
        <ui-campo rotulo="Senha temporária" tipo="password" [obrigatorio]="true" [(valor)]="novaSenha"
          dica="Mínimo de 8 caracteres." [erro]="erroSenha()" />
        @if (erroEnvioSenha(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharSenha()">Cancelar</button>
        <button type="submit" form="form-senha" class="btn btn--primario" [disabled]="salvandoSenha()">
          {{ salvandoSenha() ? 'Salvando…' : 'Redefinir' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    ui-filtros { display: block; margin: var(--espacamento-3) 0; }
    .corpo { display: grid; gap: var(--espacamento-2); min-width: 0; }
    ui-tabela { display: block; }
    .duas { display: flex; flex-direction: column; min-width: 0; }
    .tit { color: var(--texto); }
    .suave { color: var(--texto-suave); font-size: 12px; }
    p.suave { font-size: 13px; margin: 0 0 var(--espacamento-3); }
    .papeis { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .acoes { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-2); justify-content: flex-end; }
    .aviso { margin: 0 0 var(--espacamento-4); padding: var(--espacamento-3); border: 1px solid var(--atencao); border-radius: var(--raio-controle); color: var(--texto); font-size: 13px; }
    .papeis-form { margin: var(--espacamento-4) 0 0; padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .papeis-form legend { padding: 0 var(--espacamento-2); color: var(--texto-secundario); }
    .linha-papel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: var(--espacamento-3); align-items: end; }
    .linha-papel.dup { outline: 1px solid var(--erro); outline-offset: 4px; border-radius: var(--raio-controle); }
    .papeis-form > .btn { justify-self: start; }
    @media (max-width: 640px) { .linha-papel { grid-template-columns: minmax(0, 1fr); } .remover { justify-self: start; } }
    .erro-campo, .erro-envio { margin: 0; color: var(--erro); font-size: 13px; }
    .erro-envio { margin-top: var(--espacamento-3); }
  `,
})
export class UsuariosPagina implements OnInit {
  private readonly api = inject(UsuariosServico)
  private readonly filiaisApi = inject(FiliaisServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Usuário' },
    { chave: 'cargo', rotulo: 'Cargo', largura: '140px' },
    { chave: 'papeis', rotulo: 'Papéis' },
    { chave: 'ativo', rotulo: 'Situação', largura: '110px' },
    { chave: 'ultimoLoginEm', rotulo: 'Último login', mono: true, largura: '160px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '300px' },
  ]
  protected readonly opcoesStatus = OPCOES_STATUS
  protected readonly opcoesPapel = OPCOES_PAPEL

  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly itens = signal<readonly UsuarioLista[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  protected readonly busca = signal('')
  protected readonly ativo = signal('')
  protected readonly temFiltro = computed(() => this.busca().trim() !== '' || this.ativo() !== '')
  /** Só é afirmado com a lista completa e sem filtro (ver `modoFundador`). */
  private readonly fundador = signal(false)

  protected readonly filiais = signal<readonly { id: string; nome: string; ativa: boolean }[]>([])
  protected readonly opcoesFilial = computed<OpcaoSelect[]>(() =>
    this.filiais().filter((f) => f.ativa).map((f) => ({ valor: f.id, rotulo: f.nome })))

  // Modal criar/editar
  protected readonly edicao = signal<{ id: string | null } | null>(null)
  protected readonly editandoId = computed(() => this.edicao()?.id ?? null)
  protected readonly nome = signal('')
  protected readonly email = signal('')
  protected readonly telefone = signal('')
  protected readonly cargo = signal('')
  protected readonly senha = signal('')
  protected readonly linhasPapel = signal<readonly LinhaPapel[]>([])
  protected readonly duplicadas = computed(() => indicesDuplicados(this.linhasPapel()))
  protected readonly erros = signal<Partial<Record<CampoUsuario, string>>>({})
  protected readonly erroEnvio = signal<string | null>(null)
  protected readonly salvando = signal(false)
  protected readonly avisoFundador = computed(() => avisaModoFundador(this.fundador(), this.linhasPapel()))

  // Modal redefinir senha
  protected readonly senhaDe = signal<string | null>(null)
  protected readonly novaSenha = signal('')
  protected readonly erroSenha = signal<string | null>(null)
  protected readonly erroEnvioSenha = signal<string | null>(null)
  protected readonly salvandoSenha = signal(false)
  protected readonly nomeDaSenha = computed(() => this.itens().find((u) => u.id === this.senhaDe())?.nome ?? 'a pessoa')

  ngOnInit(): void {
    void this.carregar()
    void this.carregarFiliais()
  }

  protected rotuloAtribuicao = rotuloDaAtribuicao
  protected ultimoLogin = ultimoLoginTexto

  protected buscar(texto: string): void { this.busca.set(texto); void this.carregar() }
  protected limparFiltros(): void { this.busca.set(''); this.ativo.set(''); void this.carregar() }

  private consulta(cursor: string | null): { cursor: string | null; busca: string; ativo: 'true' | 'false' | '' } {
    const a = this.ativo()
    return { cursor, busca: this.busca(), ativo: a === 'true' || a === 'false' ? a : '' }
  }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.api.listar(this.consulta(null))
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      if (!this.temFiltro()) this.fundador.set(modoFundador(r.itens, r.proximoCursor === null))
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else { this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.listar(this.consulta(c))
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (u) => u.id))
      this.cursor.set(r.proximoCursor)
      if (!this.temFiltro()) this.fundador.set(modoFundador(this.itens(), r.proximoCursor === null))
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais usuários.'))
    } finally { this.carregandoMais.set(false) }
  }

  /** Filiais ativas para o select do modal (poucas; carrega todas as páginas, com teto). */
  private async carregarFiliais(): Promise<void> {
    try {
      let cursor: string | null = null
      let acumulado: { id: string; nome: string; ativa: boolean }[] = []
      for (let i = 0; i < MAX_PAGINAS_FILIAIS; i++) {
        const r = await this.filiaisApi.listar(cursor)
        acumulado = mesclarPagina(acumulado, r.itens, (f) => f.id)
        cursor = r.proximoCursor
        if (!cursor) break
      }
      this.filiais.set(acumulado)
    } catch { /* o select fica só com "Todas as filiais"; o modal continua utilizável */ }
  }

  // ---- modal criar/editar ----
  protected novo(): void {
    this.reiniciarForm()
    this.linhasPapel.set([])
    this.edicao.set({ id: null })
  }

  protected editar(id: string): void {
    const u = this.itens().find((x) => x.id === id)
    if (!u) return
    this.reiniciarForm()
    this.nome.set(u.nome)
    this.email.set(u.email)
    this.telefone.set(u.telefone ?? '')
    this.cargo.set(u.cargo ?? '')
    this.linhasPapel.set(linhasDosPapeis(u.papeis))
    this.edicao.set({ id })
  }

  private reiniciarForm(): void {
    this.nome.set(''); this.email.set(''); this.telefone.set(''); this.cargo.set(''); this.senha.set('')
    this.erros.set({}); this.erroEnvio.set(null)
  }

  protected fechar(): void { if (!this.salvando()) this.edicao.set(null) }

  protected adicionarPapel(): void { this.linhasPapel.update((l) => adicionarLinha(l)) }
  protected removerLinha(i: number): void { this.linhasPapel.update((l) => l.filter((_, k) => k !== i)) }
  protected atualizarLinha(i: number, campo: 'papel' | 'filialId', valor: string): void {
    this.linhasPapel.update((l) => l.map((x, k) => (k === i ? { ...x, [campo]: valor } : x)))
  }

  private validar(criando: boolean): boolean {
    const e: Partial<Record<CampoUsuario, string>> = {}
    const n = erroDoNome(this.nome()); if (n) e.nome = n
    if (criando) { const m = erroDoEmail(this.email()); if (m) e.email = m }
    const s = erroDaSenha(this.senha(), false); if (s && criando) e.senha = s
    if (this.linhasPapel().some((l) => !l.papel)) e.papeis = 'Escolha o papel em cada linha ou remova a linha vazia.'
    else if (temDuplicata(this.linhasPapel())) e.papeis = 'Há papel repetido para a mesma filial.'
    this.erros.set(e)
    return Object.keys(e).length === 0
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const ed = this.edicao()
    if (!ed || this.salvando()) return
    const criando = ed.id === null
    if (!this.validar(criando)) return
    this.salvando.set(true); this.erroEnvio.set(null)
    const telefone = digitosDaMascara('telefone', this.telefone()) || null
    const cargo = this.cargo().trim() || null
    const papeis = montarPapeis(this.linhasPapel())
    try {
      if (criando) {
        const senha = this.senha()
        await this.api.criar({
          nome: this.nome().trim(), email: this.email().trim(), telefone, cargo, papeis,
          ...(senha ? { senhaTemporaria: senha } : {}),
        })
        this.toast.sucesso(senha ? 'Usuário criado.' : 'Usuário criado. O convite foi enviado por e-mail.')
      } else {
        const r = await this.api.editar(ed.id!, { nome: this.nome().trim(), telefone, cargo, papeis })
        this.avisarProvedor(r.provedor)
      }
      this.edicao.set(null)
      await this.carregar()
    } catch (err) {
      this.tratarErro(err, 'Não foi possível salvar.')
    } finally { this.salvando.set(false) }
  }

  /** Erro tipificado vai para o campo; o que não tem campo vai para a faixa do modal. */
  private tratarErro(err: unknown, padrao: string): void {
    const m = mapearErroUsuario(codigoDoErro(err))
    if (m?.campo) this.erros.set({ [m.campo]: m.mensagem })
    else this.erroEnvio.set(m?.mensagem ?? mensagemDeErro(err, padrao))
  }

  private avisarProvedor(p: 'ok' | 'nao_encontrado' | 'indisponivel' | null): void {
    if (p === 'indisponivel') {
      this.toast.mostrar('Atenção: salvo; o login será atualizado quando o provedor voltar.', 'neutro', 9000)
    } else this.toast.sucesso('Alterações salvas.')
  }

  protected async alternarAtivo(id: string): Promise<void> {
    const u = this.itens().find((x) => x.id === id)
    if (!u) return
    if (u.ativo) {
      const ok = await this.confirmacao.confirmar({
        titulo: `Desativar ${u.nome}?`,
        mensagem: 'A pessoa perde o acesso ao sistema. O histórico e os papéis ficam guardados e dá para reativar.',
        acao: 'Desativar', perigo: true,
      })
      if (!ok) return
    }
    try {
      const r = await this.api.editar(id, { ativo: !u.ativo })
      this.avisarProvedor(r.provedor)
      await this.carregar()
    } catch (err) {
      this.toast.erro(mapearErroUsuario(codigoDoErro(err))?.mensagem ?? mensagemDeErro(err, 'Não foi possível alterar.'))
    }
  }

  // ---- redefinir senha ----
  protected abrirSenha(id: string): void {
    this.novaSenha.set(''); this.erroSenha.set(null); this.erroEnvioSenha.set(null)
    this.senhaDe.set(id)
  }
  protected fecharSenha(): void { if (!this.salvandoSenha()) this.senhaDe.set(null) }

  protected async salvarSenha(ev: Event): Promise<void> {
    ev.preventDefault()
    const id = this.senhaDe()
    if (!id || this.salvandoSenha()) return
    const e = erroDaSenha(this.novaSenha(), true)
    this.erroSenha.set(e)
    if (e) return
    this.salvandoSenha.set(true); this.erroEnvioSenha.set(null)
    try {
      await this.api.redefinirSenha(id, this.novaSenha())
      this.senhaDe.set(null)
      this.toast.sucesso('Senha redefinida. A pessoa troca no primeiro login.')
    } catch (err) {
      const m = mapearErroUsuario(codigoDoErro(err))
      if (m?.campo === 'senha') this.erroSenha.set(m.mensagem)
      else this.erroEnvioSenha.set(m?.mensagem ?? mensagemDeErro(err, 'Não foi possível redefinir a senha.'))
    } finally { this.salvandoSenha.set(false) }
  }
}
