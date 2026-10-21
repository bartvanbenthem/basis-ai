import { bucketProject, isProjectBucket } from './buckets';

const UID = '2bca2d23-6e64-4a59-a991-27292cce1725';

describe('bucketProject', () => {
  it('reads the name from project-<name>-backups<uid>', () => {
    expect(bucketProject(`project-singledc-backups${UID}`)).toBe('singledc');
  });

  it('reads the prefix from prj-<16>-<hash><uid>, marking a cut-off one', () => {
    expect(bucketProject(`prj-single-region-3fa91c${UID}`)).toBe('single-region');
    expect(bucketProject(`prj-team-payments-eu-9c1b44${UID}`)).toBe('team-payments-eu…');
  });

  it('ignores other buckets', () => {
    expect(bucketProject(`cosi-test-bucketclass${UID}`)).toBeUndefined();
    expect(bucketProject('project-demo-backups')).toBeUndefined();
  });
});

describe('isProjectBucket', () => {
  it('matches either form against the full project name', () => {
    expect(isProjectBucket(`project-singledc-backups${UID}`, 'singledc')).toBe(true);
    expect(isProjectBucket(`prj-single-region-3fa91c${UID}`, 'single-region')).toBe(true);
    expect(isProjectBucket(`prj-team-payments-eu-9c1b44${UID}`, 'team-payments-eu-west')).toBe(true);
    // A 16th character that is "-" is dropped from the prefix.
    expect(isProjectBucket(`prj-team-orders-and-9c1b44${UID}`, 'team-orders-and-invoices')).toBe(true);
  });

  it('does not match another project', () => {
    expect(isProjectBucket(`project-singledc-backups${UID}`, 'single')).toBe(false);
    expect(isProjectBucket(`prj-single-region-3fa91c${UID}`, 'multi-region')).toBe(false);
  });
});
