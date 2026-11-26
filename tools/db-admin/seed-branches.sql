-- Known DOCVAPE branches (more are added later from the back office). Safe to run twice.
insert into branches (name) values ('P. Campa Branch'), ('Dapitan Branch') on conflict (name) do nothing;
select id, name, is_active from branches order by name;
