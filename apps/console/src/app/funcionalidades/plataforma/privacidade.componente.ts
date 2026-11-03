import { Component, ChangeDetectionStrategy, inject, input, output, signal, computed, effect, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { textoAvisoPrivacidade } from '@geracrm/shared'
import {
  CampoComponente, GradeFormComponente, PainelComponente, ToastServico,
} from '../../compartilhado/ui/index.js'
import { mensagemFalhaAoSalvar } from './config.regras.js'
import {
  corpoDaLgpd, errosDoCorpo, errosDoServidor, formDaLgpd, resumoDosErros, FORM_LGPD_VAZIO,
  type EmpresaLida, type ErrosForm, type LgpdForm,
} from './empresa.regras.js'

interface Privacidade {
  readonly url: string | null; readonly versao: string; readonly textoPadrao: string | null
  readonly configurada: boolean; readonly previa: string
}
type Estado = 'carregando' | 'pronto' | 'erro'

/**
 * PRIVACIDADE E LGPD (raia P4 + D5) — painel das Configurações Gerais.
 *
 * Duas fontes, um botão:
 *  - o AVISO que o agente exibe na abertura da conversa (link, texto, versão) mora em
 *    `tenant_privacidade` (`/v1/privacidade`). O link do aviso É a política de privacidade
 *    da empresa: não existe segundo campo de URL (decisão da 0116);
 *  - o DPO, a retenção, o texto de consentimento e a exigência de consentimento moram em
 *    `tenant` (`/v1/config/empresa`).
 * Cada exibição do aviso fica registrada no contato com a versão, por isso trocar o texto pede versão nova.
 *
 * ⚠️ Estado próprio do aviso: se ele falhar, a tela de configurações não cai.
 * ⚠️ Gravar é de admin; os demais veem em leitura. A prévia usa a MESMA função do servidor.
 */
@Component({
  selector: 'app-privacidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CampoComponente, GradeFormComponente, PainelComponente],
  template: `
    <ui-painel>
      <h2 class="txt-secao">Privacidade e LGPD</h2>
      <p class="dica txt-corpo">O aviso vai no fim da apresentação do agente, na primeira mensagem de cada conversa, e cada exibição fica registrada no contato com a versão.</p>
      @switch (estado()) {
        @case ('carregando') { <div class="esq" aria-hidden="true"></div> }
        @case ('erro') {
          <div class="vazio txt-corpo">Não foi possível carregar o aviso de privacidade.
            <button class="btn btn--secundario" type="button" (click)="carregar()">Tentar de novo</button></div>
        }
        @case ('pronto') {
          <form (submit)="salvar($event)" novalidate>
            <ui-grade-form [colunas]="3">
              <ui-campo class="largo" rotulo="Link da política de privacidade" [valor]="url()" placeholder="https://suaempresa.com.br/privacidade"
                        [desabilitado]="leitura()" (valorChange)="url.set($event)" />
              <ui-campo class="largo" rotulo="Texto do aviso" tipo="textarea" [valor]="texto()" placeholder="Esta conversa fica registrada para te atender melhor."
                        [desabilitado]="leitura()" (valorChange)="texto.set($event)" />
              <ui-campo rotulo="Versão do aviso" [valor]="versao()" placeholder="padrao" [desabilitado]="leitura()" (valorChange)="versao.set($event)" />
              <div class="previa largo">
                <span class="txt-rotulo">Como o cliente vê</span>
                <p class="previa-texto txt-corpo">{{ previa() }}</p>
              </div>
              <ui-campo rotulo="Encarregado (DPO): nome" [valor]="lgpd().dpoNome" [erro]="erros()['dpoNome'] ?? null"
                        [desabilitado]="leitura()" (valorChange)="mudar('dpoNome', $event)" />
              <ui-campo rotulo="Encarregado (DPO): e-mail" tipo="email" [valor]="lgpd().dpoEmail" [erro]="erros()['dpoEmail'] ?? null"
                        [desabilitado]="leitura()" (valorChange)="mudar('dpoEmail', $event)" />
              <ui-campo rotulo="Retenção (meses)" tipo="text" [valor]="lgpd().retencaoMeses" [erro]="erros()['retencaoMeses'] ?? null"
                        dica="De 6 a 120. Depois disso os dados pessoais de contatos descartados são anonimizados."
                        [desabilitado]="leitura()" (valorChange)="mudar('retencaoMeses', $event)" />
              <ui-campo class="largo" rotulo="Texto de consentimento" tipo="textarea" [valor]="lgpd().textoConsentimento"
                        [erro]="erros()['textoConsentimento'] ?? null" placeholder="Autorizo receber mensagens da empresa pelo WhatsApp."
                        [desabilitado]="leitura()" (valorChange)="mudar('textoConsentimento', $event)" />
            </ui-grade-form>
            <label class="opcao txt-corpo">
              <input type="checkbox" [checked]="lgpd().exigirConsentimentoWhatsapp" [disabled]="leitura()"
                     (change)="mudarConsentimento($any($event.target).checked)" />
              <span>Exigir consentimento antes de falar com o contato pelo WhatsApp</span>
            </label>
            @if (!leitura()) {
              <div class="acoes">
                <button class="btn btn--primario" type="submit" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar privacidade' }}</button>
              </div>
            }
          </form>
        }
      }
    </ui-painel>
  `,
  styles: `
    :host { display: block; margin-bottom: var(--espacamento-4); }
    h2 { margin: 0 0 var(--espacamento-1); }
    .dica { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .esq { height: 160px; border-radius: var(--raio-controle); background: var(--superficie); }
    .vazio { color: var(--texto-suave); display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); }
    .previa { display: grid; gap: var(--espacamento-1); padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); min-width: 0; }
    .previa-texto { margin: 0; color: var(--texto); overflow-wrap: anywhere; }
    .opcao { display: flex; align-items: center; gap: var(--espacamento-2); margin-top: var(--espacamento-4); color: var(--texto); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
  `,
})
export class PrivacidadeComponente implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  readonly empresa = input.required<EmpresaLida>()
  readonly leitura = input(true)
  readonly salvou = output<Partial<EmpresaLida>>()

  readonly estado = signal<Estado>('carregando')
  readonly url = signal(''); readonly texto = signal(''); readonly versao = signal('padrao')
  readonly lgpd = signal<LgpdForm>(FORM_LGPD_VAZIO)
  readonly erros = signal<ErrosForm>({})
  readonly salvando = signal(false)
  readonly previa = computed(() => textoAvisoPrivacidade({ url: this.url(), textoPadrao: this.texto() }))
  #marca = ''

  constructor() {
    // ⚠️ Só reage a mudança dos campos DESTE painel (o painel Empresa também atualiza a empresa da página).
    effect(() => {
      const base = formDaLgpd(this.empresa())
      const marca = JSON.stringify(base)
      if (marca === this.#marca) return
      this.#marca = marca
      this.lgpd.set(base)
    })
  }

  ngOnInit(): void { void this.carregar() }

  mudar(campo: 'dpoNome' | 'dpoEmail' | 'retencaoMeses' | 'textoConsentimento', valor: string): void {
    this.lgpd.update((f) => ({ ...f, [campo]: valor }))
    this.erros.set({})
  }

  mudarConsentimento(valor: boolean): void { this.lgpd.update((f) => ({ ...f, exigirConsentimentoWhatsapp: valor })) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      this.aplicar(await firstValueFrom(this.http.get<Privacidade>('/v1/privacidade')))
      this.estado.set('pronto')
    } catch { this.estado.set('erro') }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || this.leitura()) return
    const corpo = corpoDaLgpd(this.lgpd())
    const locais = errosDoCorpo(corpo)
    if (Object.keys(locais).length > 0) { this.erros.set(locais); this.toast.erro(resumoDosErros(locais)); return }
    this.salvando.set(true)
    try {
      await firstValueFrom(this.http.patch('/v1/config/empresa', corpo))
    } catch (e) {
      // ⚠️ Preserva o que foi digitado: só a mensagem muda.
      const doServidor = errosDoServidor(e)
      if (doServidor) { this.erros.set(doServidor); this.toast.erro(resumoDosErros(doServidor)) } else this.toast.erro(mensagemFalhaAoSalvar(e))
      this.salvando.set(false)
      return
    }
    const f = this.lgpd()
    this.salvou.emit({
      dpoNome: f.dpoNome.trim() || null, dpoEmail: f.dpoEmail.trim().toLowerCase() || null,
      retencaoMeses: Number(f.retencaoMeses), textoConsentimento: f.textoConsentimento.trim() || null,
      exigirConsentimentoWhatsapp: f.exigirConsentimentoWhatsapp,
    })
    try {
      const r = await firstValueFrom(this.http.put<Privacidade>('/v1/privacidade', {
        url: this.url().trim(), versao: this.versao().trim(), textoPadrao: this.texto().trim(),
      }))
      this.aplicar(r)
      this.toast.sucesso('Privacidade salva.')
    } catch (e) {
      // Os dados de LGPD já foram; o aviso não — dizer isso, e não "erro ao salvar" genérico.
      this.toast.erro(`Dados de LGPD salvos, mas o aviso não: ${mensagemFalhaAoSalvar(e)}`)
    } finally { this.salvando.set(false) }
  }

  private aplicar(p: Privacidade): void {
    this.url.set(p.url ?? ''); this.texto.set(p.textoPadrao ?? ''); this.versao.set(p.versao)
  }
}
