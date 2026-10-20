# El Nuevo Gobierno

Web estática (todo en el navegador) que genera un cartel tipo "El nuevo Gobierno: los 15 ministros" con tu avatar y los de tus contactos de Bluesky.

## Cómo funciona

1. Escribes tu usuario de Bluesky (`nombre`, `nombre.bsky.social`, `@nombre` o la URL del perfil).
2. La app usa la API pública de Bluesky (`public.api.bsky.app`, sin login):
   - **Con quien más interactúo**: lee tus últimas ~400 publicaciones y puntúa a cada cuenta: respuesta +3, cita +3, repost +2, mención +2. Si no llega a 14, completa con gente a la que sigues.
   - **Gente a la que sigo**: 14 cuentas al azar de tus últimos ~300 seguidos.
3. Tú eres Presidencia; el resto recibe carteras por orden de interacción.
4. Se dibuja en un `<canvas>` de 1200×1500 (4:5, válido para Instagram) y se descarga como PNG.

Puedes barajar carteras o editar nombres y carteras antes de descargar.

## Desarrollo

No hay build. Sirve la carpeta con cualquier servidor estático:

```sh
python3 -m http.server 8000
```

- `?demo` (o `?demo=internet`) dibuja el cartel con datos falsos, sin red.
- `?u=handle` rellena el usuario.

## Pendiente

- X/Twitter e Instagram: no tienen API pública accesible desde el navegador; necesitarían un backend o proxy.
- Los likes no cuentan como interacción: `getActorLikes` exige autenticación.
