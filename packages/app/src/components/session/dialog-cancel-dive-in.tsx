import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogCancelDiveIn(props: { trackCount: number; onConfirm: () => Promise<boolean> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)

  const confirm = async () => {
    if (pending()) return
    setPending(true)
    const succeeded = await props.onConfirm()
    setPending(false)
    if (succeeded) dialog.close()
  }

  return (
    <Dialog title={language.t("divein.cancel.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.plural("divein.cancel.confirm", props.trackCount, { count: props.trackCount })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={pending()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={pending()} onClick={confirm}>
            {language.t("divein.cancel.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
