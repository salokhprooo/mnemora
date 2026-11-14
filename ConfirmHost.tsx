import type { ConfirmOptions } from '../../store/app';
import { Modal } from './Modal';
import { Button } from './primitives';

export function ConfirmHost({ dialog, close }: { dialog: (ConfirmOptions & { resolve: (v: boolean) => void }) | null; close: (v: boolean) => void }) {
  return (
    <Modal
      open={dialog !== null}
      onClose={() => close(false)}
      title={dialog?.title ?? ''}
      size="sm"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={dialog?.danger ? 'danger' : 'primary'} onClick={() => close(true)} data-autofocus>
            {dialog?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {dialog?.message && <p className="text-sm text-mute">{dialog.message}</p>}
    </Modal>
  );
}
