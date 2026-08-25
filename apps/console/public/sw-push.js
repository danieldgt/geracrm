/**
 * Service worker do PUSH (PLT-07) — o pedaço que roda com o console fechado.
 *
 * ⚠️ Ele existe SÓ para push. Não faz cache, não intercepta `fetch`, não serve
 * nada offline: um service worker que cacheia é o caminho mais curto para o
 * usuário ver a versão de ontem depois de um deploy — e este console já teve
 * esse problema com o `index.html` (ver nginx.conf).
 */

self.addEventListener('push', (evento) => {
  // ⚠️ Push sem dado é possível (o serviço pode entregar vazio). Nesse caso
  //    ainda avisamos: silêncio seria pior do que um aviso genérico.
  let dados = { titulo: 'Mensagem nova', corpo: 'Você tem uma mensagem no atendimento', conversaId: '' }
  try {
    if (evento.data) dados = { ...dados, ...evento.data.json() }
  } catch (_) { /* payload ilegível: fica o genérico */ }

  evento.waitUntil(
    self.registration.showNotification(dados.titulo, {
      body: dados.corpo,
      icon: '/icon-512.png',
      badge: '/favicon-32.png',
      // ⚠️ `tag` por conversa: mensagem nova da MESMA conversa substitui a
      //    anterior em vez de empilhar. Dez avisos da mesma pessoa na tela de
      //    bloqueio é o que faz alguém desligar a permissão.
      tag: dados.conversaId ? `conversa-${dados.conversaId}` : 'atendimento',
      renotify: true,
      data: { conversaId: dados.conversaId },
    }),
  )
})

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close()
  const conversaId = (evento.notification.data && evento.notification.data.conversaId) || ''
  const destino = conversaId ? `/contatos?conversa=${conversaId}` : '/contatos'

  evento.waitUntil((async () => {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // ⚠️ Reaproveita a aba que já está aberta em vez de abrir a décima: quem
    //    atende deixa o console aberto o dia inteiro, e abrir aba nova a cada
    //    notificação é como se perde a conversa que estava em cima.
    for (const aba of abas) {
      if (aba.url.includes(self.location.origin)) {
        await aba.focus()
        if ('navigate' in aba) await aba.navigate(destino)
        return
      }
    }
    await self.clients.openWindow(destino)
  })())
})
