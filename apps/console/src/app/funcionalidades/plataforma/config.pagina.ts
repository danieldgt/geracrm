import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { Router, RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  AbasComponente, CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente, HorarioAtendimentoComponente,
  PainelComponente, ToastServico, somenteDiasAbertos, type Aba, type HorarioAtendimento,
} from '../../compartilhado/ui/index.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { PrivacidadeComponente } from './privacidade.componente.js'
import { ConfigEmpresaComponente } from './config-empresa.componente.js'
import { ConfigModulosComponente } from './config-modulos.componente.js'
import { mensagemFalhaAoSalvar } from './config.regras.js'
import { somenteLeitura, type EmpresaLida } from './empresa.regras.js'

interface CanalResumo { readonly id: string; readonly nomeAmigavel: string }
interface ConfigCanal { readonly horarioAtendimento: HorarioAtendimento; readonly mensagemAusencia: string | null }
interface Membro {
  readonly id: string; readonly nome: string; readonly email: string | null; readonly ativo: boolean
  readonly papeis: { papel: string; filial: string }[]
  readonly ausente: boolean; readonly vistoEm: string | null; readonly canais: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const PAPEL_ROTULO: Record<string, string> = { admin: 'Admin', gestor: 'Gestor', supervisor: 'Supervisor', vendedor: 'Vendedor', atendente: 'Atendente' }

/**
 * Configurações (padrão C: cabeçalho + abas por rota). A aba Geral é esta tela; Agente,
 * Números e Playbook são ATALHOS para as telas que já existem (a configuração delas não mora aqui).
 *
 * Geral = painéis com cabeçalho: Empresa, Atendimento, Privacidade e LGPD, Módulos e Equipe.
 * ⚠️ Papel é POR FILIAL (mostrado como está). Gestão de usuários/acesso não é daqui.
 * ⚠️ Gestor vê tudo em leitura; só admin salva (a API barra com 403 de qualquer forma).
 */
@Component({
  selector: 'app-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, AbasComponente, CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente,
    HorarioAtendimentoComponente, PainelComponente, PrivacidadeComponente, ConfigEmpresaComponente, ConfigModulosComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Configurações" subtitulo="Dados da empresa, atendimento, privacidade, módulos e equipe." />
    <ui-abas [abas]="abas" [(ativa)]="aba" (ativaChange)="aoTrocarAba($event)" />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') { <ui-esqueleto /> }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso" descricao="Você não tem permissão para ver as configurações. Peça a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as configurações" descricao="Confira a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (leitura()) {
            <p class="aviso txt-corpo" role="note">Somente administradores alteram. Você vê tudo em leitura.</p>
          }
          @if (empresa(); as emp) {
            <app-config-empresa [empresa]="emp" [leitura]="leitura()" (salvou)="atualizarEmpresa($event)" />
          }

          <!-- ⚠️ ESPELHO, não segunda fonte da verdade: a configuração continua
               sendo por NÚMERO (canal_configuracao). Está aqui porque é onde as
               pessoas procuram — "horário de atendimento" se lê como fato da
               empresa, não do canal. Com mais de um número, esta tela não tenta
               adivinhar qual: manda para a tela que sabe. -->
          <ui-painel>
            <h2 class="txt-secao">Atendimento</h2>
            @switch (situacaoCanais()) {
              @case ('carregando') { <ui-esqueleto /> }
              @case ('erro') {
                <p class="vazio txt-corpo">Não foi possível carregar seus números.
                  <a routerLink="/canal-config">Abrir Config. do Canal</a></p>
              }
              @case ('nenhum') {
                <p class="vazio txt-corpo">Nenhum número conectado ainda. Conecte um em <a routerLink="/numeros">Meus Números</a>.</p>
              }
              @case ('varios') {
                <p class="dica txt-corpo">Você tem {{ canais().length }} números, e o horário é de cada um.</p>
                <ul class="nums">
                  @for (c of canais(); track c.id) { <li class="txt-corpo">{{ c.nomeAmigavel }}</li> }
                </ul>
                <a class="btn btn--secundario" routerLink="/canal-config">Configurar por número</a>
              }
              @case ('um') {
                <p class="dica txt-corpo">Do número <strong>{{ canais()[0]?.nomeAmigavel }}</strong>.</p>
                <form class="form" (submit)="salvarHorario($event)">
                  <label class="campo txt-denso">Mensagem de ausência
                    <textarea rows="2" [value]="ausencia()" [disabled]="leitura()"
                              (input)="ausencia.set($any($event.target).value)"
                              placeholder="Enviada a quem escreve fora do horário."></textarea>
                  </label>
                  <ui-horario-atendimento [(horario)]="horario" />
                  @if (!leitura()) {
                    <div class="acoes">
                      <button class="btn btn--primario" type="submit" [disabled]="salvandoHorario()">
                        {{ salvandoHorario() ? 'Salvando…' : 'Salvar atendimento' }}</button>
                    </div>
                  }
                </form>
              }
            }
          </ui-painel>

          @if (empresa(); as emp) {
            <app-privacidade [empresa]="emp" [leitura]="leitura()" (salvou)="atualizarEmpresa($event)" />
          }

          <app-config-modulos [leitura]="leitura()" />

          <ui-painel>
            <h2 class="txt-secao">Equipe <span class="cont">({{ equipe().length }})</span></h2>
            <p class="dica txt-corpo">Quem tem acesso e com qual papel. <a routerLink="/usuarios">Gerenciar usuários</a></p>
            @if (equipe().length === 0) {
              <p class="vazio txt-corpo">Nenhum usuário ainda.</p>
            } @else {
              <ul class="equipe">
                @for (u of equipe(); track u.id) {
                  <li class="u" [class.inativo]="!u.ativo">
                    <span class="ava">{{ inicial(u.nome) }}</span>
                    <div class="u-col encolhe">
                      <span class="u-nome txt-corpo">
                        {{ u.nome }}
                        @if (!u.ativo) { <span class="tag-inativo">inativo</span> }
                        <!-- ⚠️ Cor SEMPRE com rótulo ao lado: verde e âmbar sozinhos
                             não dizem nada para quem não enxerga a diferença. -->
                        @if (u.ativo) {
                          <span class="disp" [class.fora]="!estaDisponivel(u)">
                            {{ estaDisponivel(u) ? 'disponível' : rotuloIndisponivel(u) }}
                          </span>
                        }
                      </span>
                      @if (u.email) { <span class="u-email">{{ u.email }}</span> }
                    </div>
                    <div class="papeis">
                      @for (p of u.papeis; track p.papel + p.filial) {
                        <span class="papel" [title]="p.filial">{{ rotuloPapel(p.papel) }}</span>
                      }
                      @if (u.papeis.length === 0) { <span class="sem-papel">sem papel</span> }
                    </div>
                  </li>
                }
              </ul>
            }
          </ui-painel>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-4); min-width: 0; }
    .corpo > * { min-width: 0; }
    .aviso { margin: 0; padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); }
    ui-painel h2 { margin: 0 0 var(--espacamento-1); }
    .cont { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .vazio { color: var(--texto-suave); margin: 0; }
    .form { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); }
    .campo textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; min-width: 0; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); margin-top: var(--espacamento-1); }
    .nums { list-style: none; margin: 0 0 var(--espacamento-3); padding: 0; display: grid; gap: var(--espacamento-1); }
    .nums li { color: var(--texto); }
    .equipe { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .u { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); }
    .u:last-child { border-bottom: none; }
    .u.inativo { opacity: .6; }
    .ava { width: 30px; height: 30px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--acao); font-size: 12px; font-weight: 600; display: grid; place-items: center; flex: none; }
    .u-col { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .u-nome { color: var(--texto); }
    .tag-inativo { font-size: 11px; color: var(--texto-suave); }
    .disp { font-size: 11px; color: var(--sucesso); border: 1px solid var(--sucesso);
      border-radius: var(--raio-completo); padding: 0 6px; white-space: nowrap; }
    .disp.fora { color: var(--texto-suave); border-color: var(--borda); }
    .u-email { color: var(--texto-suave); font-size: 12px; overflow-wrap: anywhere; }
    .papeis { display: flex; gap: 4px; flex-wrap: wrap; flex: none; justify-content: flex-end; }
    .papel { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto-secundario); border: 1px solid var(--borda); }
    .sem-papel { font-size: 11px; color: var(--texto-suave); }
  `,
})
export class ConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastServico)
  private readonly modulos = inject(ModulosServico)

  /** Geral é esta tela; as outras três levam a telas existentes. Playbook é aba do agente (`?aba=playbook`), sem rota própria. */
  readonly abas: readonly Aba[] = [
    { id: 'geral', rotulo: 'Geral', rota: '/config' },
    { id: 'agente', rotulo: 'Agente', rota: '/agente' },
    { id: 'numeros', rotulo: 'Números', rota: '/numeros' },
    { id: 'playbook', rotulo: 'Playbook' },
  ]
  readonly aba = signal('geral')

  readonly estado = signal<Estado>('carregando')
  readonly empresa = signal<EmpresaLida | null>(null)
  readonly equipe = signal<readonly Membro[]>([])
  readonly admin = signal<boolean | null>(null)
  readonly leitura = computed(() => somenteLeitura(this.admin()))

  readonly canais = signal<readonly CanalResumo[]>([])
  readonly canaisFalharam = signal(false)
  readonly horario = signal<HorarioAtendimento>({})
  readonly ausencia = signal('')
  readonly salvandoHorario = signal(false)

  /**
   * ⚠️ Estado PRÓPRIO da seção. Se a lista de números falhar, esta tela não
   * quebra inteira — o quinto estado da skill de layout: o principal carrega, o
   * secundário avisa no lugar dele.
   */
  readonly situacaoCanais = computed<'carregando' | 'erro' | 'nenhum' | 'um' | 'varios'>(() => {
    if (this.canaisFalharam()) return 'erro'
    if (this.estado() !== 'pronto') return 'carregando'
    const n = this.canais().length
    return n === 0 ? 'nenhum' : n === 1 ? 'um' : 'varios'
  })

  ngOnInit(): void { void this.carregar() }
  inicial(n: string): string { return (n.trim()[0] ?? '?').toUpperCase() }

  /** O atalho do Playbook não tem rota própria: abre a tela do agente já na aba certa. */
  aoTrocarAba(id: string): void {
    if (id === 'playbook') void this.router.navigate(['/agente'], { queryParams: { aba: 'playbook' } })
  }

  /**
   * ⚠️ A MESMA régua do servidor (`disponibilidade.ts`): 5 minutos de batimento.
   * Se as duas divergirem, a tela vai dizer que alguém está disponível enquanto
   * o agente já assumiu as conversas dele — e ninguém entende por quê.
   */
  estaDisponivel(u: Membro): boolean {
    if (u.ausente || !u.vistoEm) return false
    return Date.now() - new Date(u.vistoEm).getTime() < 5 * 60_000
  }

  /** Por que não está disponível — o motivo importa mais que o estado. */
  rotuloIndisponivel(u: Membro): string {
    if (u.ausente) return 'ausente'
    if (!u.vistoEm) return 'nunca entrou'
    const min = Math.floor((Date.now() - new Date(u.vistoEm).getTime()) / 60_000)
    return min < 60 ? `fora há ${min} min` : `fora há ${Math.floor(min / 60)} h`
  }
  rotuloPapel(p: string): string { return PAPEL_ROTULO[p] ?? p }

  atualizarEmpresa(parcial: Partial<EmpresaLida>): void {
    const atual = this.empresa()
    if (atual) this.empresa.set({ ...atual, ...parcial })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [emp, eq, eu] = await Promise.all([
        firstValueFrom(this.http.get<EmpresaLida>('/v1/config/empresa')),
        firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/config/equipe')),
        // ⚠️ Papel só decide o que MOSTRAR; sem resposta fica em leitura (a API barra o resto).
        firstValueFrom(this.http.get<{ admin?: boolean }>('/v1/config/eu')).catch(() => ({ admin: false })),
        this.modulos.carregar(true),
      ])
      this.empresa.set(emp)
      this.equipe.set(eq.itens)
      this.admin.set(eu.admin === true)
      this.estado.set('pronto')
      void this.carregarAtendimento()
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  /** ⚠️ Pós-carga e tolerante a falha: nunca derruba a tela principal. */
  private async carregarAtendimento(): Promise<void> {
    this.canaisFalharam.set(false)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: CanalResumo[] }>('/v1/canais'))
      this.canais.set(r.itens)
      const unico = r.itens.length === 1 ? r.itens[0] : null
      if (!unico) return
      const cf = await firstValueFrom(this.http.get<ConfigCanal>(`/v1/canais/${unico.id}/config`))
      this.horario.set({ ...cf.horarioAtendimento })
      this.ausencia.set(cf.mensagemAusencia ?? '')
    } catch { this.canaisFalharam.set(true) }
  }

  async salvarHorario(ev: Event): Promise<void> {
    ev.preventDefault()
    const unico = this.canais().length === 1 ? this.canais()[0] : null
    if (!unico || this.salvandoHorario() || this.leitura()) return
    this.salvandoHorario.set(true)
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${unico.id}/config`, {
        horarioAtendimento: somenteDiasAbertos(this.horario()),
        mensagemAusencia: this.ausencia(),
      }))
      this.toast.sucesso('Atendimento salvo.')
    } catch (e) { this.toast.erro(mensagemFalhaAoSalvar(e)) } finally { this.salvandoHorario.set(false) }
  }
}
