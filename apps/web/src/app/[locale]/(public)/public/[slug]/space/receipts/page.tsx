import SpaceShell from '../SpaceShell'
import ReceiptsHome from './ReceiptsHome'

export const dynamic = 'force-dynamic'

export default function SpaceReceiptsPage() {
  return (
    <SpaceShell>
      <ReceiptsHome />
    </SpaceShell>
  )
}
