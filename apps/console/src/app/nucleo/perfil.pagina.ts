import { Component, ChangeDetectionStrategy, computed, inject, OnInit, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { Router, RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import { AuthServico, ehProducao } from './auth.servico.js'
import { PresencaServico } from './presenca.servico.js'
import { PreferenciasNotificacaoComponente } from './preferencias-notificacao.componente.js'
import {
  camposDoCorpo, corpoDoPerfil, erroDaFoto, errosDaSenha, errosDoPerfil, formDoPerfil, iniciaisDe, mudouOPerfil,
  type ErrosForm, type PerfilForm, type PerfilLido, type SenhaForm,
} from './perfil.regras.js'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, EsqueletoComponente, EstadoComponente,
  FormPaginaComponente, GradeFormComponente, PainelComponente, SecaoFormComponente, ToastServico, corpoDoErro,
  ehStatus, mensagemDeErro,
} from '../compartilhado/ui/index.js'

/**
 * Meu perfil (D4), padrão Formulário (F): nome, telefone (máscara, grava dígitos), cargo, foto, presença,
 * troca de senha e preferências de aviso.
 *
 * ⚠️ É SEMPRE o perfil do token: não há `/perfil/:id`. Papel e filial não se editam aqui (isso é do
 * cadastro de Usuários). Falha ao salvar preserva o que foi digitado; 422 vai para o campo.
 * ⚠️ A sessão de suporte (staff dentro de um cliente) não tem perfil próprio: a tela diz isso.
 */
@Component({
  selector: 'app-perfil',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, BadgeComponente, CabecalhoTelaComponente, CampoComponente, EsqueletoComponente, EstadoComponente,
    FormPaginaComponente, GradeFormComponente, PainelComponente, PreferenciasNotificacaoComponente, SecaoFormComponente,
  ],
  template: `
    <div class="pagina">
      <ui-cabecalho-tela titulo="Meu perfil" subtitulo="Quem você é neste console, como avisamos você e sua senha." />

      @switch (estado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true"><ui-esqueleto altura="24px" /><ui-esqueleto altura="24px" /><ui-esqueleto altura="120px" /></div>
        }
        @case ('sem_perfil') {
          <ui-estado tipo="sem-permissao" titulo="A sessão de suporte não tem perfil próprio"
                     descricao="Você está dentro de um cliente como suporte. Saia do cliente e entre com o seu login para editar o seu perfil." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o seu perfil" [descricao]="erroCarga() ?? ''">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <ui-form-pagina titulo="Meus dados" subtitulo="O que aparece para a sua equipe.">
            <ui-secao-form titulo="Foto">
              <div class="foto">
                @if (perfil()?.fotoUrl; as url) {
                  <img class="avatar" [src]="url" alt="Sua foto de perfil" />
                } @else {
                  <span class="avatar sem-foto" aria-hidden="true">{{ iniciais() }}</span>
                }
                <div class="foto-acoes">
                  @if (perfil()?.fotoDisponivel) {
                    <label class="btn btn--secundario btn--pequeno" [class.desabilitado]="enviandoFoto()">
                      {{ enviandoFoto() ? 'Enviando…' : 'Trocar foto' }}
                      <input class="arquivo" type="file" accept="image/jpeg,image/png,image/webp" [disabled]="enviandoFoto()"
                             (change)="escolherFoto($event)" />
                    </label>
                    @if (perfil()?.fotoUrl) {
                      <button type="button" class="btn btn--fantasma btn--pequeno" [disabled]="enviandoFoto()" (click)="removerFoto()">Remover</button>
                    }
                    <span class="txt-denso dica">JPG, PNG ou WebP, até 2 MB.</span>
                  } @else {
                    <span class="txt-denso dica">O envio de foto não está disponível neste ambiente.</span>
                  }
                </div>
              </div>
              @if (erroFoto()) { <p class="erro" role="alert">{{ erroFoto() }}</p> }
            </ui-secao-form>

            <ui-secao-form titulo="Dados pessoais">
              <form (submit)="salvar($event)" novalidate id="form-perfil">
                <ui-grade-form [colunas]="2">
                  <ui-campo rotulo="Nome" [obrigatorio]="true" [valor]="form().nome" [erro]="erros()['nome'] ?? null"
                            (valorChange)="mudar('nome', $event)" />
                  <ui-campo rotulo="E-mail" [valor]="perfil()?.email ?? ''" [desabilitado]="true"
                            dica="O e-mail é o seu login. Quem altera é o administrador." />
                  <ui-campo rotulo="Telefone" mascara="telefone" tipo="tel" [valor]="form().telefone" [erro]="erros()['telefone'] ?? null"
                            (valorChange)="mudar('telefone', $event)" />
                  <ui-campo rotulo="Cargo" [valor]="form().cargo" [erro]="erros()['cargo'] ?? null"
                            (valorChange)="mudar('cargo', $event)" />
                </ui-grade-form>
              </form>
            </ui-secao-form>

            <div rodape>
              <button type="submit" form="form-perfil" class="btn btn--primario" [disabled]="salvando() || !mudou()">
                {{ salvando() ? 'Salvando…' : 'Salvar dados' }}
              </button>
            </div>
          </ui-form-pagina>

          <ui-painel>
            <h2 class="txt-secao">Empresa e presença</h2>
            <p class="txt-corpo sub">
              Empresa:
              @if (auth.sessaoStaff(); as s) { {{ s.clienteNome }} <ui-badge tom="atencao">acesso de staff</ui-badge> }
              @else if (auth.ehStaff()) { Drezz <ui-badge tom="info">staff</ui-badge> }
              @else { a empresa do seu login }
            </p>
            <p class="txt-corpo sub">
              Disponível: você atende e o agente só cobre fora do expediente.
              Ausente: você acompanha, o agente responde por você e ninguém espera resposta sua.
            </p>
            <label class="alternar">
              <input type="checkbox" role="switch" [checked]="!presenca.ausente()" [disabled]="presenca.mexendo()"
                     [attr.aria-checked]="!presenca.ausente()" (change)="presenca.alternar()" />
              <span>{{ presenca.ausente() ? 'Ausente — só acompanhando' : 'Disponível — na mesa' }}</span>
            </label>
          </ui-painel>

          <ui-painel>
            <h2 class="txt-secao">Trocar senha</h2>
            <p class="txt-corpo sub">Confirmamos a senha atual antes de trocar. A nova senha vale no próximo login.</p>
            <form (submit)="trocarSenha($event)" novalidate>
              <ui-grade-form [colunas]="3">
                <ui-campo rotulo="Senha atual" tipo="password" autocomplete="current-password" [valor]="senha().atual"
                          [erro]="errosSenha()['senhaAtual'] ?? null" (valorChange)="mudarSenha('atual', $event)" />
                <ui-campo rotulo="Nova senha" tipo="password" autocomplete="new-password" [valor]="senha().nova"
                          [erro]="errosSenha()['novaSenha'] ?? null" (valorChange)="mudarSenha('nova', $event)" />
                <ui-campo rotulo="Confirmar nova senha" tipo="password" autocomplete="new-password" [valor]="senha().confirmacao"
                          [erro]="errosSenha()['confirmacao'] ?? null" (valorChange)="mudarSenha('confirmacao', $event)" />
              </ui-grade-form>
              <div class="acoes">
                <button type="submit" class="btn btn--primario" [disabled]="trocandoSenha()">
                  {{ trocandoSenha() ? 'Trocando…' : 'Trocar senha' }}
                </button>
              </div>
            </form>
          </ui-painel>

          <ui-painel>
            <h2 class="txt-secao" id="preferencias">Preferências de aviso</h2>
            <p class="txt-corpo sub">
              Por onde você quer receber cada tipo de aviso. A lista completa está em
              <a routerLink="/notificacoes">Notificações</a>.
            </p>
            <app-preferencias-notificacao />
          </ui-painel>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .pagina > * + * { margin-top: var(--espacamento-4); }
    .esqueletos { display: grid; gap: var(--espacamento-3); }
    h2 { margin: 0 0 var(--espacamento-2); color: var(--texto); }
    .sub { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); max-width: 70ch; }
    .sub a { color: var(--acao); }
    .alternar { display: inline-flex; align-items: center; gap: var(--espacamento-3); cursor: pointer; color: var(--texto); }
    .alternar input { width: 18px; height: 18px; accent-color: var(--acao); }
    .foto { display: flex; align-items: center; gap: var(--espacamento-4); flex-wrap: wrap; }
    .foto-acoes { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .avatar { width: 72px; height: 72px; border-radius: var(--raio-completo); object-fit: cover; flex: none; }
    .avatar.sem-foto { display: inline-flex; align-items: center; justify-content: center; background: var(--acao-suave);
      color: var(--acao); font-weight: 600; font-size: 24px; }
    .arquivo { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    label.btn { position: relative; cursor: pointer; }
    label.btn.desabilitado { opacity: .6; cursor: default; }
    .dica { color: var(--texto-suave); }
    .erro { margin: 0; color: var(--erro); }
    .acoes { display: flex; justify-content: flex-end; margin-top: var(--espacamento-4); }
  `,
})
export class PerfilPagina implements OnInit {
  readonly auth = inject(AuthServico)
  readonly presenca = inject(PresencaServico)
  readonly dev = !ehProducao()
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly router = inject(Router)

  protected readonly estado = signal<'carregando' | 'pronto' | 'erro' | 'sem_perfil'>('carregando')
  protected readonly erroCarga = signal<string | null>(null)
  protected readonly perfil = signal<PerfilLido | null>(null)
  protected readonly form = signal<PerfilForm>({ nome: '', telefone: '', cargo: '' })
  private readonly base = signal<PerfilForm>({ nome: '', telefone: '', cargo: '' })
  protected readonly erros = signal<ErrosForm>({})
  protected readonly salvando = signal(false)
  protected readonly mudou = computed(() => mudouOPerfil(this.base(), this.form()))
  protected readonly iniciais = computed(() => iniciaisDe(this.perfil()?.nome ?? ''))

  protected readonly enviandoFoto = signal(false)
  protected readonly erroFoto = signal<string | null>(null)

  protected readonly senha = signal<SenhaForm>({ atual: '', nova: '', confirmacao: '' })
  protected readonly errosSenha = signal<ErrosForm>({})
  protected readonly trocandoSenha = signal(false)

  ngOnInit(): void { void this.carregar() }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const p = await firstValueFrom(this.http.get<PerfilLido>('/v1/perfil'))
      this.aplicar(p)
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) { this.estado.set('sem_perfil'); return }
      this.erroCarga.set(mensagemDeErro(e, 'Não foi possível carregar o seu perfil. Tente de novo.'))
      this.estado.set('erro')
    }
  }

  private aplicar(p: PerfilLido): void {
    this.perfil.set(p)
    const f = formDoPerfil(p)
    this.base.set(f)
    this.form.set(f)
  }

  protected mudar(campo: keyof PerfilForm, valor: string): void {
    this.form.update((f) => ({ ...f, [campo]: valor }))
    if (Object.keys(this.erros()).length > 0) this.erros.set({})
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || !this.mudou()) return
    const locais = errosDoPerfil(this.form())
    if (Object.keys(locais).length > 0) { this.erros.set(locais); return }
    this.salvando.set(true)
    try {
      const p = await firstValueFrom(this.http.patch<PerfilLido>('/v1/perfil', corpoDoPerfil(this.form())))
      this.aplicar(p)
      this.erros.set({})
      this.toast.sucesso('Dados salvos.')
    } catch (e) {
      // Preserva o digitado; 422 vai para o campo.
      const doServidor = camposDoCorpo(corpoDoErro(e))
      if (doServidor) this.erros.set(doServidor)
      this.toast.erro(mensagemDeErro(e, 'Não foi possível salvar. Tente de novo.'))
    } finally { this.salvando.set(false) }
  }

  protected async escolherFoto(ev: Event): Promise<void> {
    const entrada = ev.target as HTMLInputElement
    const arquivo = entrada.files?.[0]
    entrada.value = ''
    if (!arquivo) return
    const recusa = erroDaFoto(arquivo)
    if (recusa) { this.erroFoto.set(recusa); return }
    this.erroFoto.set(null)
    this.enviandoFoto.set(true)
    try {
      const corpo = new FormData()
      corpo.append('foto', arquivo, arquivo.name)
      const p = await firstValueFrom(this.http.put<PerfilLido>('/v1/perfil/foto', corpo))
      this.perfil.set(p)
      this.toast.sucesso('Foto atualizada.')
    } catch (e) {
      this.erroFoto.set(mensagemDeErro(e, 'Não foi possível enviar a foto. Tente de novo.'))
    } finally { this.enviandoFoto.set(false) }
  }

  protected async removerFoto(): Promise<void> {
    this.enviandoFoto.set(true)
    try {
      await firstValueFrom(this.http.delete('/v1/perfil/foto'))
      this.perfil.update((p) => (p ? { ...p, fotoUrl: null } : p))
    } catch (e) {
      this.erroFoto.set(mensagemDeErro(e, 'Não foi possível remover a foto. Tente de novo.'))
    } finally { this.enviandoFoto.set(false) }
  }

  protected mudarSenha(campo: keyof SenhaForm, valor: string): void {
    this.senha.update((s) => ({ ...s, [campo]: valor }))
    if (Object.keys(this.errosSenha()).length > 0) this.errosSenha.set({})
  }

  protected async trocarSenha(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.trocandoSenha()) return
    const locais = errosDaSenha(this.senha())
    if (Object.keys(locais).length > 0) { this.errosSenha.set(locais); return }
    this.trocandoSenha.set(true)
    try {
      await firstValueFrom(this.http.post('/v1/perfil/senha', { senhaAtual: this.senha().atual, novaSenha: this.senha().nova }))
      this.senha.set({ atual: '', nova: '', confirmacao: '' })
      // O servidor encerrou TODAS as sessões (inclusive esta): sem sair aqui, a próxima chamada cai em 401.
      this.toast.sucesso('Senha trocada. Entre de novo com a nova senha.')
      this.auth.sair(false)
      void this.router.navigateByUrl('/login')
    } catch (e) {
      // Senha atual errada e política vêm tipificadas por campo; o digitado fica.
      const doServidor = camposDoCorpo(corpoDoErro(e))
      if (doServidor) this.errosSenha.set(doServidor)
      else this.toast.erro(mensagemDeErro(e, 'Não foi possível trocar a senha. Tente de novo.'))
    } finally { this.trocandoSenha.set(false) }
  }
}
