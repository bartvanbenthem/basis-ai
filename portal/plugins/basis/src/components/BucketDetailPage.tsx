import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  Button,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Header,
  Link,
  Skeleton,
  Table,
  Text,
  TextField,
  useTable,
} from '@backstage/ui';
import {
  type BucketDetails,
  type BucketFolder,
  cnpgBucketDeletePermission,
} from '@internal/backstage-plugin-cnpg-common';
import { type ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { cnpgApiRef } from '../api';
import { bucketsRouteRef, clusterRouteRef, projectRouteRef } from '../routes';
import { age, BucketStateBadge, ErrorAlert, Fields, Mono, Panel, usageText } from './common';

/** Deletes an orphaned bucket with everything in it, after typing its name. */
const DeleteDialog = ({
  bucket,
  isOpen,
  onOpenChange,
}: {
  bucket: BucketDetails;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(bucketsRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);
  const { name, usage, formerProject } = bucket.summary;
  const { objects, size } = usageText(usage);

  const onDelete = async () => {
    setPending(true);
    setError(undefined);
    try {
      await api.deleteBucket(name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/cnpg/buckets');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <DialogHeader>Delete bucket?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            Deletes bucket <Mono>{name}</Mono> on {bucket.endpoint} with its {objects} objects ({size}).
            This can't be undone.
          </Text>
          {formerProject && (
            <Text color="secondary">
              It holds the backups of deleted project {formerProject}: no cluster can be restored from
              them afterwards.
            </Text>
          )}
          <TextField label="Type the bucket name to confirm" value={confirm} onChange={setConfirm} />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" destructive isDisabled={confirm !== name} loading={pending} onPress={onDelete}>
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

type FolderRow = BucketFolder & { id: string };

const FolderTable = ({ bucket }: { bucket: BucketDetails }) => {
  const clusterLink = useRouteRef(clusterRouteRef);
  const { project } = bucket.summary;
  const columns: ColumnConfig<FolderRow>[] = [
    {
      id: 'path',
      label: 'Folder',
      isRowHeader: true,
      cell: f => (
        <Cell>
          <Mono>{f.path}</Mono>
        </Cell>
      ),
    },
    {
      id: 'cluster',
      label: 'Cluster',
      cell: f => (
        <Cell>
          {f.cluster && f.active && project ? (
            <Link href={clusterLink?.({ namespace: project, name: f.cluster })}>{f.cluster}</Link>
          ) : (
            <Text variant="body-small" color="secondary">
              {f.cluster ? `${f.cluster} (deleted)` : '-'}
            </Text>
          )}
        </Cell>
      ),
    },
    { id: 'objects', label: 'Objects', cell: f => <CellText title={usageText(f).objects} /> },
    { id: 'size', label: 'Size', cell: f => <CellText title={usageText(f).size} /> },
    { id: 'written', label: 'Last write', cell: f => <CellText title={age(f.lastModified)} /> },
  ];
  const { tableProps } = useTable({
    mode: 'complete',
    data: bucket.folders.map(f => ({ ...f, id: f.path })),
    paginationOptions: { pageSize: 20 },
  });
  return (
    <Table columnConfig={columns} {...tableProps} emptyState={<Text color="secondary">The bucket is empty.</Text>} />
  );
};

/** One bucket: what uses it, its usage per folder, and deleting it when orphaned. */
export const BucketDetailPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const projectLink = useRouteRef(projectRouteRef);
  const { allowed: canDelete } = usePermission({ permission: cnpgBucketDeletePermission });
  const [deleting, setDeleting] = useState(false);
  const { value, error } = useAsyncRetry(() => api.getBucket(name), [api, name]);
  const summary = value?.summary;
  const { objects, size } = usageText(summary?.usage);

  let usedBy: ReactNode = 'nothing on the cluster';
  if (summary?.project) {
    usedBy = (
      <Text variant="body-small">
        project <Link href={projectLink?.({ name: summary.project })}>{summary.project}</Link>
        {' '}(its backup bucket)
      </Text>
    );
  } else if (summary?.cosiBucket) {
    usedBy = `COSI Bucket ${summary.cosiBucket} (a BucketClaim outside a project)`;
  }

  return (
    <>
      <Header
        title={name}
        tags={[{ label: 'bucket' }]}
        customActions={
          <Flex gap="3" align="center">
            {summary && <BucketStateBadge state={summary.state} />}
            {canDelete && summary?.state === 'orphaned' && (
              <Button variant="secondary" destructive onPress={() => setDeleting(true)}>
                Delete
              </Button>
            )}
          </Flex>
        }
      />
      <Container>
        {error && !value && <ErrorAlert error={error} />}
        {!error && !value && <Skeleton width="100%" height={240} />}
        {value && summary && (
          <Flex direction="column" gap="4">
            {value.storeError && (
              <Alert
                status="warning"
                title="Object store unreachable"
                description={`Showing what the cluster knows of this bucket; its usage and folders need the object store. ${value.storeError}`}
              />
            )}
            {summary.state === 'orphaned' && (
              <Alert
                status="warning"
                title="Orphaned"
                description={
                  summary.formerProject
                    ? `Created for project ${summary.formerProject}, which no longer exists. Its backups stay here until the bucket is deleted.`
                    : 'Nothing on the cluster uses this bucket: no Project and no COSI Bucket refers to it.'
                }
              />
            )}
            <Panel title="Bucket">
              <Fields
                rows={[
                  ['Used by', usedBy],
                  ['Endpoint', value.endpoint ? <Mono key="e">{`${value.endpoint}/${name}`}</Mono> : '-'],
                  ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
                  ['Objects', objects],
                  ['Size', size],
                  ['Last write', summary.usage?.lastModified ? `${age(summary.usage.lastModified)} ago` : '-'],
                ]}
              />
            </Panel>
            {!value.storeError && (
              <Panel title="Folders">
                <FolderTable bucket={value} />
              </Panel>
            )}
          </Flex>
        )}
      </Container>
      {value && <DeleteDialog bucket={value} isOpen={deleting} onOpenChange={setDeleting} />}
    </>
  );
};
